from datetime import datetime, timedelta, timezone

from app.auth.sessions import SESSION_COOKIE, create_session
from app.snowflake.provider import get_cache
from tests.fakes import FakeCol

from tests.test_discovery import (
    DESCRIBE_DESC,
    DESCRIBE_ROWS,
    SHOW_DESC_WITH_OWNER,
)

INFO_SCHEMA_DESC = [
    FakeCol("TABLE_SCHEMA"), FakeCol("TABLE_NAME"), FakeCol("LAST_ALTERED"),
    FakeCol("LAST_DDL"), FakeCol("IS_DYNAMIC"), FakeCol("ROW_COUNT"),
]
LOADED = datetime(2026, 8, 22, 6, 15, tzinfo=timezone.utc)
DEFINED = LOADED - timedelta(days=9)


class ScriptedCursor:
    """Routes DESCRIBE/SHOW/SELECT to canned results, recording every SQL."""

    def __init__(self):
        self.executed: list[str] = []
        #: Positionally aligned with `executed`: what each call bound, or None.
        self.bound: list = []
        #: When set, plain SELECTs answer with these rows instead of the
        #: default two -- lets a test drive the distinct-values endpoint.
        self.value_rows: list[tuple] | None = None
        #: What SHOW SEMANTIC VIEWS reports as the owning role, and what
        #: Snowflake answers when asked whether this session holds it. Both
        #: are knobs because certification's whole contract is what happens
        #: for each answer.
        self.owner: str | None = "DATA_ENG"
        self.owner_role_type: str | None = "ROLE"
        self.may_certify: bool | None = True
        self.freshness_rows: list[tuple] = [
            ("PUBLIC", "ORDERS_RAW", LOADED, DEFINED, "NO", 42),
        ]
        #: Set to make only the INFORMATION_SCHEMA read fail, which is how a
        #: stopped warehouse presents: the rest of the page still has to draw.
        self.freshness_error: Exception | None = None
        self._rows: list = []
        self.description: list = []
        self.sfqid = "q-77"

    def execute(self, sql: str, params=None):
        self.executed.append(sql)
        self.bound.append(params)
        if sql.startswith("SHOW SEMANTIC VIEWS"):
            # Owner columns included: certification asks Snowflake whether the
            # caller holds the owning role, and has nothing to ask about
            # without them.
            self.description = SHOW_DESC_WITH_OWNER
            self._rows = [(
                "2026-01-01", "SALES", "ANALYTICS", "PUBLIC", None,
                self.owner, self.owner_role_type,
            )]
        elif "IS_ROLE_IN_SESSION" in sql or "IS_DATABASE_ROLE_IN_SESSION" in sql:
            self.description = [FakeCol("PERMITTED")]
            self._rows = [(self.may_certify,)]
        elif "INFORMATION_SCHEMA.TABLES" in sql:
            if self.freshness_error is not None:
                raise self.freshness_error
            self.description = INFO_SCHEMA_DESC
            self._rows = list(self.freshness_rows)
        elif "CURRENT_ACCOUNT()" in sql:
            # The identity probe. Matches what sign_in() stores, so a feed
            # request authenticated with these fakes maps to the same app
            # user a cookie session does.
            self.description = [FakeCol("ACCT"), FakeCol("USR")]
            self._rows = [("ACME", "ALICE")]
        elif "CURRENT_ORGANIZATION_NAME" in sql:
            # Answered explicitly: without this the catch-all below returns
            # data rows for an identity query, and the org-account identifier
            # comes out as "2026-01-01-10.0".
            self.description = [FakeCol("ORG"), FakeCol("ACCT")]
            self._rows = [("ACME", "MAIN")]
        elif sql.startswith("DESCRIBE SEMANTIC VIEW"):
            self.description = DESCRIBE_DESC
            # ORDERS resolves to a physical table so freshness has something
            # to ask about; CUSTOMERS deliberately does not, which is the
            # ordinary mixed case the About page has to render.
            self._rows = list(DESCRIBE_ROWS) + [
                ("TABLE", "ORDERS", None, "BASE_TABLE_DATABASE_NAME", "ANALYTICS"),
                ("TABLE", "ORDERS", None, "BASE_TABLE_SCHEMA_NAME", "PUBLIC"),
                ("TABLE", "ORDERS", None, "BASE_TABLE_NAME", "ORDERS_RAW"),
            ]
        elif self.value_rows is not None:
            self.description = [FakeCol("VALUE", 2)]
            self._rows = list(self.value_rows)
        else:
            self.description = [FakeCol("ORDER_DATE", 3), FakeCol("TOTAL_REVENUE", 0)]
            self._rows = [("2026-01-01", 10.0), ("2026-01-02", 20.0)]
        return self

    def fetchall(self):
        return list(self._rows)

    def fetchmany(self, n: int):
        return self._rows[:n]

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def close(self):
        pass


class ScriptedConnection:
    def __init__(self):
        self.cursor_obj = ScriptedCursor()
        self.closed = False

    def cursor(self):
        return self.cursor_obj

    def is_closed(self):
        return self.closed

    def close(self):
        self.closed = True


def login(client, db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    conn = ScriptedConnection()
    get_cache().put(sess.id, conn)
    client.cookies.set(SESSION_COOKIE, sess.id)
    return conn


class ExpiredTokenCursor(ScriptedCursor):
    """What a connection does once Snowflake's side of it has expired:
    still reports open, fails every statement with the OAuth token error."""

    def execute(self, sql, params=None):
        from snowflake.connector.errors import ProgrammingError

        self.executed.append(sql)
        raise ProgrammingError(msg="OAuth access token expired. [1234]", errno=390318)


def test_an_expired_snowflake_token_is_refreshed_silently(client, db, monkeypatch):
    # The app session is fine; only the Snowflake token behind it has run
    # out. The list still loads: the dead connection is replaced by one on
    # a refreshed token, and the caller never sees a 401, let alone the
    # "Failed to load semantic views" this used to be.
    from app.auth import oauth as oauth_mod
    from app.auth.oauth import TokenResponse
    from app.snowflake import connect as sf_connect

    sess = create_session(
        db, account="ACME", user="ALICE", mode="oauth",
        access_token="at-1", refresh_token="rt-1",
        access_expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )
    dead = ScriptedConnection()
    dead.cursor_obj = ExpiredTokenCursor()
    get_cache().put(sess.id, dead)
    client.cookies.set(SESSION_COOKIE, sess.id)

    class StubOAuth:
        def refresh(self, refresh_token):
            assert refresh_token == "rt-1"
            return TokenResponse("at-2", "rt-2", 600)

    monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
    fresh = ScriptedConnection()
    monkeypatch.setattr(
        sf_connect, "connect_oauth",
        lambda token, user=None, role=None, account=None: fresh,
    )

    r = client.get("/api/semantic-views")
    assert r.status_code == 200
    assert r.json()["views"][0]["name"] == "SALES"
    assert dead.closed is True
    assert any(sql.startswith("SHOW SEMANTIC VIEWS") for sql in fresh.cursor_obj.executed)


def test_endpoints_require_auth(client):
    assert client.get("/api/semantic-views").status_code == 401
    assert client.post("/api/query/semantic", json={}).status_code == 401


def test_list_and_describe(client, db):
    login(client, db)
    r = client.get("/api/semantic-views", params={"database": "ANALYTICS"})
    assert r.status_code == 200
    assert r.json()["views"][0]["name"] == "SALES"

    r = client.get("/api/semantic-views/ANALYTICS/PUBLIC/SALES")
    assert r.status_code == 200
    body = r.json()
    assert body["dimensions"][0]["name"] == "ORDER_DATE"
    assert body["metrics"][0]["name"] == "TOTAL_REVENUE"


def test_semantic_query_roundtrip(client, db):
    conn = login(client, db)
    r = client.post(
        "/api/query/semantic",
        json={
            "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
            "dimensions": ["ORDERS.ORDER_DATE"], "metrics": ["ORDERS.TOTAL_REVENUE"],
            "limit": 100,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["columns"][0]["name"] == "ORDER_DATE"
    assert body["rows"] == [["2026-01-01", 10.0], ["2026-01-02", 20.0]]
    assert body["truncated"] is False
    assert 'SEMANTIC_VIEW' in body["sql"]
    # the DESCRIBE ran before the SELECT, on the same user connection
    assert any(s.startswith("DESCRIBE") for s in conn.cursor_obj.executed)


def test_semantic_query_unknown_field_is_400(client, db):
    login(client, db)
    r = client.post(
        "/api/query/semantic",
        json={
            "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
            "dimensions": ["ORDERS.NOPE"], "metrics": [],
        },
    )
    assert r.status_code == 400
    assert r.json()["code"] == "QUERY_ERROR"


def _select_index(cursor) -> int:
    return next(
        i for i, s in enumerate(cursor.executed)
        if "SEMANTIC_VIEW" in s and not s.startswith("DESCRIBE")
    )


def test_a_filtered_query_binds_its_values(client, db):
    conn = login(client, db)
    r = client.post(
        "/api/query/semantic",
        json={
            "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
            "dimensions": ["ORDERS.ORDER_DATE"], "metrics": ["ORDERS.TOTAL_REVENUE"],
            "filters": [{"id": "f1", "field": "CUSTOMERS.REGION", "op": "is",
                         "values": ["EAST", "WEST"]}],
        },
    )
    assert r.status_code == 200
    cursor = conn.cursor_obj
    at = _select_index(cursor)
    assert cursor.bound[at] == ["EAST", "WEST"]
    assert "EAST" not in cursor.executed[at], "value leaked into SQL text"


def test_an_unfiltered_query_binds_an_empty_list(client, db):
    conn = login(client, db)
    client.post(
        "/api/query/semantic",
        json={
            "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
            "dimensions": ["ORDERS.ORDER_DATE"], "metrics": ["ORDERS.TOTAL_REVENUE"],
        },
    )
    cursor = conn.cursor_obj
    assert cursor.bound[_select_index(cursor)] == []


def test_a_hostile_filter_value_reaches_the_cursor_as_data(client, db):
    """The route-level half of the injection round trip: the value must arrive
    in the binding, not in the statement."""
    conn = login(client, db)
    hostile = "' OR 1=1 --"
    r = client.post(
        "/api/query/semantic",
        json={
            "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
            "metrics": ["ORDERS.TOTAL_REVENUE"],
            "filters": [{"id": "f1", "field": "CUSTOMERS.REGION", "op": "is",
                         "values": [hostile]}],
        },
    )
    assert r.status_code == 200
    cursor = conn.cursor_obj
    at = _select_index(cursor)
    assert cursor.bound[at] == [hostile]
    assert hostile not in cursor.executed[at]
    # And it must not come back to the caller inside the echoed SQL either.
    assert hostile not in r.json()["sql"]


def test_an_unknown_filter_operator_is_422(client, db):
    login(client, db)
    r = client.post(
        "/api/query/semantic",
        json={
            "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
            "metrics": ["ORDERS.TOTAL_REVENUE"],
            "filters": [{"id": "f1", "field": "CUSTOMERS.REGION", "op": "regex",
                         "values": [".*"]}],
        },
    )
    assert r.status_code == 422


def test_a_filter_on_an_unknown_field_is_400(client, db):
    login(client, db)
    r = client.post(
        "/api/query/semantic",
        json={
            "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
            "metrics": ["ORDERS.TOTAL_REVENUE"],
            "filters": [{"id": "f1", "field": "CUSTOMERS.NOPE", "op": "is",
                         "values": ["X"]}],
        },
    )
    assert r.status_code == 400
    assert r.json()["code"] == "QUERY_ERROR"


def test_distinct_values_for_a_dimension(client, db):
    login(client, db)
    r = client.get(
        "/api/semantic-views/ANALYTICS/PUBLIC/SALES/values",
        params={"field": "ORDERS.ORDER_DATE"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["values"] == ["2026-01-01", "2026-01-02"]
    assert body["truncated"] is False


def test_distinct_values_dedupes_sorts_and_drops_nulls(client, db):
    conn = login(client, db)
    conn.cursor_obj.value_rows = [("WEST",), ("EAST",), ("WEST",), (None,)]
    r = client.get(
        "/api/semantic-views/ANALYTICS/PUBLIC/SALES/values",
        params={"field": "CUSTOMERS.REGION"},
    )
    assert r.json()["values"] == ["EAST", "WEST"]


def test_distinct_values_validates_the_field_against_describe(client, db):
    login(client, db)
    r = client.get(
        "/api/semantic-views/ANALYTICS/PUBLIC/SALES/values",
        params={"field": "CUSTOMERS.NOPE"},
    )
    assert r.status_code == 400
    assert r.json()["code"] == "QUERY_ERROR"


def test_distinct_values_requires_auth(client):
    r = client.get(
        "/api/semantic-views/ANALYTICS/PUBLIC/SALES/values", params={"field": "A.B"}
    )
    assert r.status_code == 401


def test_distinct_values_reports_truncation_at_the_cap(client, db, monkeypatch):
    from app.semantic import routes as semantic_routes

    monkeypatch.setattr(semantic_routes, "VALUES_CAP", 2)
    conn = login(client, db)
    conn.cursor_obj.value_rows = [("A",), ("B",), ("C",)]
    r = client.get(
        "/api/semantic-views/ANALYTICS/PUBLIC/SALES/values",
        params={"field": "CUSTOMERS.REGION"},
    )
    body = r.json()
    assert body["values"] == ["A", "B"]
    assert body["truncated"] is True


def test_distinct_values_defaults_to_one_screenful(client, db):
    """Ten, not a thousand. A picker is not a place to read a column; the
    search box below is how you reach the eleventh value."""
    conn = login(client, db)
    conn.cursor_obj.value_rows = [(f"V{i:03}",) for i in range(50)]
    r = client.get(
        "/api/semantic-views/ANALYTICS/PUBLIC/SALES/values",
        params={"field": "CUSTOMERS.REGION"},
    )
    body = r.json()
    assert len(body["values"]) == 10
    assert body["truncated"] is True


def test_distinct_values_search_is_bound_not_interpolated(client, db):
    conn = login(client, db)
    conn.cursor_obj.value_rows = [("EAST",)]
    hostile = "'; DROP TABLE customers; --"
    r = client.get(
        "/api/semantic-views/ANALYTICS/PUBLIC/SALES/values",
        params={"field": "CUSTOMERS.REGION", "search": hostile},
    )
    assert r.status_code == 200
    sql = conn.cursor_obj.executed[-1]
    # The needle reaches Snowflake as a bound parameter and never as text --
    # the same rule every other filter value obeys, which is why search goes
    # through the ordinary filter path rather than a bespoke one.
    assert hostile not in sql
    assert "CONTAINS(UPPER(" in sql
    assert conn.cursor_obj.bound[-1] == [hostile.upper()]


def test_distinct_values_search_narrows_inside_the_view(client, db):
    """Inside, not after. A column of 150 000 names cannot be searched by
    fetching a page and filtering it: the name wanted is not in the page."""
    conn = login(client, db)
    conn.cursor_obj.value_rows = [("EAST",)]
    client.get(
        "/api/semantic-views/ANALYTICS/PUBLIC/SALES/values",
        params={"field": "CUSTOMERS.REGION", "search": "eas"},
    )
    sql = conn.cursor_obj.executed[-1]
    inside = sql[sql.index("SEMANTIC_VIEW(") : sql.rindex(")")]
    assert "WHERE CONTAINS(UPPER(" in inside


def test_distinct_values_blank_search_adds_no_predicate(client, db):
    conn = login(client, db)
    conn.cursor_obj.value_rows = [("EAST",)]
    client.get(
        "/api/semantic-views/ANALYTICS/PUBLIC/SALES/values",
        params={"field": "CUSTOMERS.REGION", "search": "   "},
    )
    assert "CONTAINS" not in conn.cursor_obj.executed[-1]


def test_distinct_values_limit_is_capped(client, db):
    """A caller asking for the whole column gets the backstop, not the column."""
    conn = login(client, db)
    conn.cursor_obj.value_rows = [(f"V{i:04}",) for i in range(2000)]
    r = client.get(
        "/api/semantic-views/ANALYTICS/PUBLIC/SALES/values",
        params={"field": "CUSTOMERS.REGION", "limit": 999999},
    )
    assert len(r.json()["values"]) == 1000


def test_distinct_values_does_not_shadow_the_describe_route(client, db):
    """Both routes live under the same prefix; a view literally named
    "values" must not be swallowed by the values endpoint."""
    login(client, db)
    r = client.get("/api/semantic-views/ANALYTICS/PUBLIC/SALES")
    assert r.status_code == 200
    assert r.json()["dimensions"][0]["name"] == "ORDER_DATE"


def test_describe_exposes_model_hierarchies_as_an_empty_list(client, db):
    """Empty, not absent: the frontend merges this with report-defined
    hierarchies, and a missing key would make that merge conditional."""
    login(client, db)
    r = client.get("/api/semantic-views/ANALYTICS/PUBLIC/SALES")
    assert r.status_code == 200
    assert r.json()["modelHierarchies"] == []
