"""Sharing shares report DEFINITIONS. It never shares data.

Every query runs on `entry.conn` -- the connection belonging to the requesting
session, from that user's own Snowflake login. There is no service account, no
stored result set, and the describe cache lives inside each session's
CacheEntry rather than in a process global.

So two members of one workspace open the same report and get the same
definition, and each gets exactly the data their own Snowflake role permits. A
viewer whose role cannot read the view sees the report's shape and none of its
numbers. That is correct, not a bug to work around.

2a shipped a bug where the CLIENT query cache served one user's results to
another. These tests exist so the server-side equivalent cannot ship quietly.
"""

import pytest
from snowflake.connector.errors import ProgrammingError

from app.auth.sessions import SESSION_COOKIE, create_session
from app.db.models import Report, Workspace, WorkspaceMember
from app.snowflake.provider import get_cache
from tests.test_report_routes import valid_definition
from tests.test_semantic_routes import ScriptedConnection

QUERY = {
    "database": "ANALYTICS",
    "schema": "PUBLIC",
    "view": "SALES",
    "dimensions": ["ORDERS.ORDER_DATE"],
    "metrics": ["ORDERS.TOTAL_REVENUE"],
}


class ForbiddenConnection(ScriptedConnection):
    """A connection whose role may DESCRIBE but may not SELECT.

    Shaped after what Snowflake actually does: the view's existence is
    visible, its data is not.
    """

    def cursor(self):
        cursor = super().cursor()
        if getattr(cursor, "_forbidden_wrapped", False):
            return cursor
        original = cursor.execute

        def execute(sql, params=None):
            if "SEMANTIC_VIEW" in sql and not sql.startswith("DESCRIBE"):
                raise ProgrammingError(
                    msg="Insufficient privileges to operate on semantic view",
                    errno=3001,
                )
            return original(sql, params)

        cursor.execute = execute
        cursor._forbidden_wrapped = True
        return cursor


@pytest.fixture
def shared(client, db):
    """Alice and Bob both belong to one workspace holding one report.

    Alice's connection answers normally; Bob's refuses to SELECT.
    """
    alice = create_session(db, account="ACME", user="ALICE", mode="dev")
    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()

    workspace = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(workspace)
    db.flush()
    db.add_all(
        [
            WorkspaceMember(
                workspace_id=workspace.id, user_id=alice.user_id, role="admin"
            ),
            WorkspaceMember(
                workspace_id=workspace.id, user_id=bob.user_id, role="viewer"
            ),
        ]
    )
    report = Report(
        owner_user_id=alice.user_id,
        workspace_id=workspace.id,
        name="Shared",
        view_database="ANALYTICS",
        view_schema="PUBLIC",
        view_name="SALES",
        definition=valid_definition(),
    )
    db.add(report)
    db.commit()

    alice_conn, bob_conn = ScriptedConnection(), ForbiddenConnection()
    get_cache().put(alice.id, alice_conn)
    get_cache().put(bob.id, bob_conn)
    return {
        "alice": alice,
        "bob": bob,
        "report": report,
        "alice_conn": alice_conn,
        "bob_conn": bob_conn,
    }


def as_user(client, sess):
    client.cookies.set(SESSION_COOKIE, sess.id)
    return client


def test_both_members_get_the_same_definition(client, db, shared):
    """The definition IS shared. That is the whole point of a workspace."""
    report_id = shared["report"].id
    alice = as_user(client, shared["alice"]).get(f"/api/reports/{report_id}")
    bob = as_user(client, shared["bob"]).get(f"/api/reports/{report_id}")
    assert alice.status_code == bob.status_code == 200
    assert alice.json()["definition"] == bob.json()["definition"]


def test_each_member_queries_on_their_own_connection(client, db, shared):
    """The load-bearing assertion. If a shared connection were ever
    introduced, one of these two counts would stay at zero."""
    as_user(client, shared["alice"]).post("/api/query/semantic", json=QUERY)
    assert shared["alice_conn"].cursor_obj.executed
    assert not shared["bob_conn"].cursor_obj.executed


def test_a_viewer_whose_role_cannot_read_gets_no_data(client, db, shared):
    """Bob may open the report and may not see its numbers. The definition
    crossed the workspace boundary; the data did not."""
    report_id = shared["report"].id
    detail = as_user(client, shared["bob"]).get(f"/api/reports/{report_id}")
    assert detail.status_code == 200
    assert detail.json()["definition"]["pages"][0]["visuals"]

    query = client.post("/api/query/semantic", json=QUERY)
    assert query.status_code == 403
    assert query.json()["code"] == "SNOWFLAKE_FORBIDDEN"
    assert "rows" not in query.json()


def test_alice_still_gets_her_data(client, db, shared):
    """The negative case above must not pass merely because nothing works."""
    query = as_user(client, shared["alice"]).post("/api/query/semantic", json=QUERY)
    assert query.status_code == 200
    assert query.json()["rows"]


def test_a_describe_is_never_served_across_users(client, db, shared):
    """The describe cache lives inside each session's CacheEntry. If it were
    ever hoisted to a process global, Bob would be served Alice's catalog --
    the shape of a view he may not be entitled to see."""
    url = "/api/semantic-views/ANALYTICS/PUBLIC/SALES"
    as_user(client, shared["alice"]).get(url)
    assert any(
        s.startswith("DESCRIBE") for s in shared["alice_conn"].cursor_obj.executed
    )

    as_user(client, shared["bob"]).get(url)
    assert any(
        s.startswith("DESCRIBE") for s in shared["bob_conn"].cursor_obj.executed
    ), "Bob's DESCRIBE was served from another user's cache"


def test_a_viewer_cannot_edit_what_they_can_read(client, db, shared):
    """Read access and write access are separate grants even inside one
    workspace."""
    report_id = shared["report"].id
    response = as_user(client, shared["bob"]).put(
        f"/api/reports/{report_id}", json={"definition": valid_definition()}
    )
    assert response.status_code == 403
    assert response.json()["code"] == "WORKSPACE_FORBIDDEN"
