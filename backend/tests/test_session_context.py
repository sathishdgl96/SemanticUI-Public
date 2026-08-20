"""Switching role and warehouse: validated, applied, remembered.

Role and warehouse are IDENTIFIERS, so they cannot be bound as
parameters the way every value in this codebase is. The protection is
different in kind and worth testing directly: the choice must be one
Snowflake itself just said the user may use, and it must be refused
before it reaches the connection -- not after.
"""

from app.db.models import User
from app.snowflake.provider import get_cache
from tests.fakes import FakeCol, FakeConnection, FakeCursor
from tests.test_report_routes import sign_in


class ContextCursor(FakeCursor):
    """Answers SHOW GRANTS / SHOW WAREHOUSES; records USE statements."""

    def execute(self, sql: str, params=None):
        self.executed.append(sql)
        self.bound.append(params)
        upper = sql.upper()
        if upper.startswith("SHOW GRANTS TO USER"):
            self.description = [FakeCol("role")]
            self.rows = [("ANALYST",), ("FINANCE",), ("ANALYST",)]
        elif upper.startswith("SHOW WAREHOUSES"):
            self.description = [FakeCol("name")]
            self.rows = [("COMPUTE_WH",), ("BIG_WH",)]
        else:
            self.description = []
            self.rows = []
        return self

    def use_statements(self) -> list[str]:
        return [s for s in self.executed if s.upper().startswith("USE ")]


def login_with_context(client, db):
    sess = sign_in(client, db)
    cursor = ContextCursor()
    get_cache().put(sess.id, FakeConnection(cursor))
    db.commit()
    return sess, cursor


class TestReadingContext:
    def test_it_lists_what_the_user_may_use(self, client, db):
        login_with_context(client, db)
        body = client.get("/api/session/context").json()
        # Deduplicated: a user granted the same role twice is one choice.
        assert body["roles"] == ["ANALYST", "FINANCE"]
        assert body["warehouses"] == ["COMPUTE_WH", "BIG_WH"]

    def test_a_fresh_user_has_chosen_nothing_yet(self, client, db):
        login_with_context(client, db)
        body = client.get("/api/session/context").json()
        assert body["role"] is None
        assert body["warehouse"] is None

    def test_it_needs_a_session(self, client):
        assert client.get("/api/session/context").status_code == 401


class TestSwitching:
    def test_a_valid_switch_is_applied_and_remembered(self, client, db):
        sess, cursor = login_with_context(client, db)
        response = client.post(
            "/api/session/context", json={"role": "FINANCE", "warehouse": "BIG_WH"}
        )
        assert response.status_code == 200
        assert response.json() == {"role": "FINANCE", "warehouse": "BIG_WH"}

        applied = " ".join(cursor.use_statements()).upper()
        assert "USE ROLE" in applied and "FINANCE" in applied
        assert "USE WAREHOUSE" in applied and "BIG_WH" in applied

        user = db.get(User, sess.user_id)
        db.refresh(user)
        assert (user.last_role, user.last_warehouse) == ("FINANCE", "BIG_WH")

    def test_the_users_own_spelling_does_not_matter(self, client, db):
        sess, _ = login_with_context(client, db)
        client.post("/api/session/context", json={"role": "finance"})
        user = db.get(User, sess.user_id)
        db.refresh(user)
        # Stored as Snowflake spells it, not as the caller typed it.
        assert user.last_role == "FINANCE"

    def test_one_may_be_changed_without_the_other(self, client, db):
        sess, _ = login_with_context(client, db)
        client.post("/api/session/context", json={"role": "FINANCE"})
        client.post("/api/session/context", json={"warehouse": "BIG_WH"})
        user = db.get(User, sess.user_id)
        db.refresh(user)
        assert (user.last_role, user.last_warehouse) == ("FINANCE", "BIG_WH")

    def test_a_role_the_user_lacks_is_refused_before_the_connection(self, client, db):
        _, cursor = login_with_context(client, db)
        response = client.post("/api/session/context", json={"role": "ACCOUNTADMIN"})
        assert response.status_code == 400
        assert cursor.use_statements() == []

    def test_a_warehouse_the_user_lacks_is_refused(self, client, db):
        _, cursor = login_with_context(client, db)
        assert client.post(
            "/api/session/context", json={"warehouse": "SOMEONE_ELSES_WH"}
        ).status_code == 400
        assert cursor.use_statements() == []

    def test_an_injected_identifier_never_reaches_the_connection(self, client, db):
        _, cursor = login_with_context(client, db)
        for attempt in ('X" OR 1=1--', "ANALYST; DROP TABLE users", "AN'ALYST"):
            assert client.post(
                "/api/session/context", json={"role": attempt}
            ).status_code == 400
        assert cursor.use_statements() == []

    def test_a_refused_switch_is_not_remembered(self, client, db):
        sess, _ = login_with_context(client, db)
        client.post("/api/session/context", json={"role": "ACCOUNTADMIN"})
        user = db.get(User, sess.user_id)
        db.refresh(user)
        assert user.last_role is None


class TestAudit:
    def test_the_switch_is_recorded_without_data(self, client, db):
        from app.db.models import AuditEvent

        login_with_context(client, db)
        client.post("/api/session/context", json={"role": "FINANCE"})
        event = (
            db.query(AuditEvent).filter(AuditEvent.action == "session.context").one()
        )
        assert event.detail["role"] == "FINANCE"
        assert event.outcome == "ok"
