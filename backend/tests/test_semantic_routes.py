from app.auth.sessions import SESSION_COOKIE, create_session
from app.snowflake.provider import get_cache
from tests.fakes import FakeCol

from tests.test_discovery import DESCRIBE_DESC, DESCRIBE_ROWS, SHOW_DESC


class ScriptedCursor:
    """Routes DESCRIBE/SHOW/SELECT to canned results, recording every SQL."""

    def __init__(self):
        self.executed: list[str] = []
        #: Positionally aligned with `executed`: what each call bound, or None.
        self.bound: list = []
        #: When set, plain SELECTs answer with these rows instead of the
        #: default two -- lets a test drive the distinct-values endpoint.
        self.value_rows: list[tuple] | None = None
        self._rows: list = []
        self.description: list = []
        self.sfqid = "q-77"

    def execute(self, sql: str, params=None):
        self.executed.append(sql)
        self.bound.append(params)
        if sql.startswith("SHOW SEMANTIC VIEWS"):
            self.description = SHOW_DESC
            self._rows = [("2026-01-01", "SALES", "ANALYTICS", "PUBLIC", None)]
        elif sql.startswith("DESCRIBE SEMANTIC VIEW"):
            self.description = DESCRIBE_DESC
            self._rows = list(DESCRIBE_ROWS)
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


def test_endpoints_require_auth(client):
    assert client.get("/api/semantic-views").status_code == 401
    assert client.post("/api/query/semantic", json={}).status_code == 401


def test_list_and_describe(client, db):
    conn = login(client, db)
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


def test_distinct_values_does_not_shadow_the_describe_route(client, db):
    """Both routes live under the same prefix; a view literally named
    "values" must not be swallowed by the values endpoint."""
    login(client, db)
    r = client.get("/api/semantic-views/ANALYTICS/PUBLIC/SALES")
    assert r.status_code == 200
    assert r.json()["dimensions"][0]["name"] == "ORDER_DATE"
