r"""The Power Query feed: one visual's numbers over plain HTTP.

The product rules under test are the same two as everywhere else: every
query runs on the CALLER'S OWN connection -- reached through the connect
token, which names their signed-in app session -- and the workspace decides
which reports may be read.
"""

import base64

import pytest

from app.errors import ApiError
from app.feed.render import to_csv, to_json
from app.feed.service import build_feed_request
from app.snowflake.provider import get_cache
from tests.test_report_routes import sign_in
from tests.test_semantic_routes import ScriptedConnection


def feed_definition():
    """A current-version document whose fields exist in DETAIL below."""
    return {
        "schemaVersion": 3,
        "name": "Sales overview",
        "view": {"database": "ANALYTICS", "schema": "PUBLIC", "name": "SALES"},
        "canvas": {"columns": 12, "rowHeight": 40},
        "pages": [
            {
                "id": "p1",
                "name": "Page 1",
                "visuals": [
                    {
                        "id": "v1",
                        "type": "bar",
                        "title": "",
                        "layout": {"x": 0, "y": 0, "w": 6, "h": 6},
                        "wells": {
                            "axis": ["ORDERS.ORDER_DATE"],
                            "legend": [],
                            "values": ["ORDERS.TOTAL_REVENUE"],
                        },
                        "options": {},
                        "filters": [],
                    }
                ],
                "filters": [],
            }
        ],
        "filters": [],
        "hierarchies": [],
    }


class TestCsv:
    def test_header_then_rows_rfc4180(self):
        out = to_csv(["REGION", "TOTAL"], [["EAST", 10], ["WEST", 20]])
        assert out == "REGION,TOTAL\r\nEAST,10\r\nWEST,20\r\n"

    def test_commas_and_newlines_are_quoted_not_row_splitting(self):
        out = to_csv(["A"], [["x,y"], ["line1\nline2"]])
        assert '"x,y"' in out
        assert '"line1\nline2"' in out

    def test_a_formula_shaped_value_is_disarmed(self):
        # Power Query never evaluates formulas; the person who saves the
        # response as .csv and double-clicks it gets Excel, which does.
        out = to_csv(["A"], [["=cmd|'/c calc'!A0"], ["@SUM(1)"]])
        assert "'=cmd" in out
        assert "'@SUM" in out
        assert "\n=cmd" not in out

    def test_a_negative_number_stays_a_number(self):
        out = to_csv(["N"], [[-5], [-2.5]])
        assert "-5" in out and "'-5" not in out

    def test_null_is_empty_not_the_word_none(self):
        assert to_csv(["A", "B"], [[None, 1]]).splitlines()[1] == ",1"


class TestJson:
    def test_verbatim_values_and_truncation_flag(self):
        import json

        body = json.loads(to_json(["A"], [["=danger"]], truncated=True))
        # JSON is the byte-exact channel; the CSV guard does not apply here.
        assert body["rows"] == [["=danger"]]
        assert body["truncated"] is True


DETAIL = {
    "tables": [{"name": "ORDERS"}, {"name": "CUSTOMERS"}],
    "relationships": [],
    "dimensions": [
        {"table": "ORDERS", "name": "ORDER_DATE", "dataType": "DATE"},
        {"table": "CUSTOMERS", "name": "REGION", "dataType": "TEXT"},
    ],
    "metrics": [{"table": "ORDERS", "name": "TOTAL_REVENUE", "dataType": "NUMBER"}],
    "facts": [],
}


class FakeReport:
    view_database, view_schema, view_name = "ANALYTICS", "PUBLIC", "SALES"

    def __init__(self, definition):
        self.definition = definition


class TestRequestBuilding:
    def test_wells_and_all_three_filter_scopes_compose(self):
        definition = feed_definition()
        page = definition["pages"][0]
        visual = page["visuals"][0]
        visual["filters"] = [
            {"id": "v1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}
        ]
        page["filters"] = [
            {"id": "p1", "field": "ORDERS.ORDER_DATE", "op": "isNotBlank"}
        ]
        definition["filters"] = [
            {"id": "r1", "field": "CUSTOMERS.REGION", "op": "isNot", "values": ["X"]}
        ]
        request = build_feed_request(
            FakeReport(definition), visual["id"],
            extra_filters={}, limit=None, detail=DETAIL,
        )
        assert request.dimensions and request.metrics
        assert [f.id for f in request.filters] == ["r1", "p1", "v1"]

    def test_url_filters_are_validated_and_appended(self):
        definition = feed_definition()
        visual_id = definition["pages"][0]["visuals"][0]["id"]
        request = build_feed_request(
            FakeReport(definition), visual_id,
            extra_filters={"CUSTOMERS.REGION": "WEST"}, limit=None, detail=DETAIL,
        )
        added = request.filters[-1]
        assert added.field == "CUSTOMERS.REGION"
        assert added.values == ["WEST"]

    def test_an_unknown_url_filter_field_is_refused(self):
        definition = feed_definition()
        visual_id = definition["pages"][0]["visuals"][0]["id"]
        with pytest.raises(ApiError):
            build_feed_request(
                FakeReport(definition), visual_id,
                extra_filters={"CUSTOMERS.NOPE": "x"}, limit=None, detail=DETAIL,
            )

    def test_an_unknown_visual_is_not_found(self):
        with pytest.raises(ApiError) as excinfo:
            build_feed_request(
                FakeReport(feed_definition()), "vNOPE",
                extra_filters={}, limit=None, detail=DETAIL,
            )
        assert excinfo.value.status == 404

    def test_top_n_caps_the_limit(self):
        definition = feed_definition()
        visual = definition["pages"][0]["visuals"][0]
        visual["options"] = {"topN": 5, "sort": {"field": "ORDERS.TOTAL_REVENUE", "direction": "desc"}}
        request = build_feed_request(
            FakeReport(definition), visual["id"],
            extra_filters={}, limit=100, detail=DETAIL,
        )
        assert request.limit == 5
        assert request.order_by[0].field == "ORDERS.TOTAL_REVENUE"

    def test_a_hierarchy_serves_its_top_level(self):
        definition = feed_definition()
        definition["hierarchies"] = [
            {"id": "h1", "name": "Geo",
             "levels": ["CUSTOMERS.REGION", "ORDERS.ORDER_DATE"]}
        ]
        visual = definition["pages"][0]["visuals"][0]
        visual["wells"]["axis"] = ["hierarchy:h1"]
        request = build_feed_request(
            FakeReport(definition), visual["id"],
            extra_filters={}, limit=None, detail=DETAIL,
        )
        assert "CUSTOMERS.REGION" in request.dimensions
        assert not any(d.startswith("hierarchy:") for d in request.dimensions)


def basic(username: str, password: str) -> dict:
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


@pytest.fixture
def feed_report(client, db):
    """A signed-in user, their report, their scripted connection in the app
    cache, and a connect token minted through the real endpoint."""
    sess = sign_in(client, db)
    db.commit()
    from app.db.models import User, Workspace, WorkspaceMember

    db.query(User).filter(User.id == sess.user_id).one()
    workspace = (
        db.query(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .filter(WorkspaceMember.user_id == sess.user_id)
        .one()
    )
    from app.db.models import Report

    report = Report(
        owner_user_id=sess.user_id,
        workspace_id=workspace.id,
        name="R",
        view_database="ANALYTICS",
        view_schema="PUBLIC",
        view_name="SALES",
        definition=feed_definition(),
    )
    db.add(report)
    db.commit()

    conn = ScriptedConnection()
    get_cache().put(sess.id, conn, rebuildable=False)
    minted = client.post("/api/connect/token")
    assert minted.status_code == 200, minted.text
    token = minted.json()["token"]
    visual_id = report.definition["pages"][0]["visuals"][0]["id"]
    return report, visual_id, token, conn


class TestRoute:
    def test_no_credentials_prompts_basic(self, client, db, feed_report):
        report, visual_id, _, _ = feed_report
        response = client.get(f"/api/feed/reports/{report.id}/visuals/{visual_id}.csv")
        assert response.status_code == 401
        assert "Basic" in response.headers["WWW-Authenticate"]

    def test_csv_comes_back_for_the_token_holder(self, client, db, feed_report):
        report, visual_id, token, _ = feed_report
        response = client.get(
            f"/api/feed/reports/{report.id}/visuals/{visual_id}.csv",
            headers=basic("token", token),
        )
        assert response.status_code == 200, response.text
        assert response.headers["content-type"].startswith("text/csv")
        lines = response.text.strip().splitlines()
        assert lines[0] == "ORDER_DATE,TOTAL_REVENUE"
        assert len(lines) == 3  # header + the scripted connection's two rows
        assert response.headers["X-Truncated"] == "false"

    def test_json_variant(self, client, db, feed_report):
        report, visual_id, token, _ = feed_report
        response = client.get(
            f"/api/feed/reports/{report.id}/visuals/{visual_id}.json",
            headers=basic("token", token),
        )
        body = response.json()
        assert body["columns"] == ["ORDER_DATE", "TOTAL_REVENUE"]
        assert body["truncated"] is False

    def test_a_wrong_token_is_unauthorized(self, client, db, feed_report):
        report, visual_id, _, _ = feed_report
        response = client.get(
            f"/api/feed/reports/{report.id}/visuals/{visual_id}.csv",
            headers=basic("token", "xlt_wrong"),
        )
        assert response.status_code == 401

    def test_a_strangers_token_gets_not_found_not_forbidden(
        self, client, db, feed_report
    ):
        # A perfectly valid token whose user is not a member of the report's
        # workspace: reported as not-found, so the feed does not reveal
        # which reports exist.
        from app.auth import connect_token
        from app.auth.sessions import create_session

        stranger = create_session(db, account="ACME", user="STRANGER", mode="dev")
        get_cache().put(stranger.id, ScriptedConnection(), rebuildable=False)
        token, _ = connect_token.mint(db, stranger)
        report, visual_id, _, _ = feed_report
        response = client.get(
            f"/api/feed/reports/{report.id}/visuals/{visual_id}.csv",
            headers=basic("token", token),
        )
        assert response.status_code == 404

    def test_a_url_filter_reaches_the_sql_as_a_bound_parameter(
        self, client, db, feed_report
    ):
        report, visual_id, token, conn = feed_report
        response = client.get(
            f"/api/feed/reports/{report.id}/visuals/{visual_id}.csv",
            params={"f.CUSTOMERS.REGION": "WE'ST"},
            headers=basic("token", token),
        )
        assert response.status_code == 200
        sql = conn.cursor_obj.executed[-1]
        assert "WE'ST" not in sql          # value never becomes SQL text
        assert "?" in sql
        assert "WE'ST" in conn.cursor_obj.bound[-1]
