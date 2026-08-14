from app.auth.sessions import SESSION_COOKIE, create_session
from app.snowflake.provider import get_cache
from tests.fakes import FakeCol

from tests.test_discovery import DESCRIBE_DESC, DESCRIBE_ROWS, SHOW_DESC


class ScriptedCursor:
    """Routes DESCRIBE/SHOW/SELECT to canned results, recording every SQL."""

    def __init__(self):
        self.executed: list[str] = []
        self._rows: list = []
        self.description: list = []
        self.sfqid = "q-77"

    def execute(self, sql: str):
        self.executed.append(sql)
        if sql.startswith("SHOW SEMANTIC VIEWS"):
            self.description = SHOW_DESC
            self._rows = [("2026-01-01", "SALES", "ANALYTICS", "PUBLIC", None)]
        elif sql.startswith("DESCRIBE SEMANTIC VIEW"):
            self.description = DESCRIBE_DESC
            self._rows = list(DESCRIBE_ROWS)
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
