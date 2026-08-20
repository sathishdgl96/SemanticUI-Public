"""Switching role and warehouse: validated, applied, remembered.

Role and warehouse are IDENTIFIERS, so they cannot be bound as
parameters the way every value in this codebase is. The protection is
different in kind and worth testing directly: the choice must be one
Snowflake itself just said the user may use, and it must be refused
before it reaches the connection -- not after.

The fake here is the one from test_session_context_shape.py, whose
column layouts are a verbatim capture from Snowflake. An invented fake
is what let the first version of this feature ship reading a timestamp
column as a role name.
"""

from app.db.models import User
from app.snowflake.provider import get_cache
from tests.fakes import FakeConnection
from tests.test_report_routes import sign_in
from tests.test_session_context_shape import SnowflakeShapedCursor


def login_with_context(client, db):
    sess = sign_in(client, db)
    cursor = SnowflakeShapedCursor()
    get_cache().put(sess.id, FakeConnection(cursor))
    db.commit()
    return sess, cursor


def use_statements(cursor) -> list[str]:
    return [s for s in cursor.executed if s.upper().startswith("USE ")]


class TestReadingContext:
    def test_it_lists_what_the_user_may_use(self, client, db):
        login_with_context(client, db)
        body = client.get("/api/session/context").json()
        # Role grants only: the CREATE SCHEMA and OWNERSHIP rows in the
        # same rowset grant privileges, not roles.
        assert body["roles"] == ["ACCOUNTADMIN", "ANALYST", "ORGADMIN"]
        assert body["warehouses"] == ["COMPUTE_WH", "BIG_WH"]

    def test_it_reports_the_live_context_not_a_stored_preference(self, client, db):
        sess, cursor = login_with_context(client, db)
        cursor.current_role = "ANALYST"
        # A preference that was never applied must not be presented as
        # what the session is running as.
        user = db.get(User, sess.user_id)
        user.last_role = "SOMETHING_ELSE"
        db.commit()
        assert client.get("/api/session/context").json()["role"] == "ANALYST"

    def test_it_needs_a_session(self, client):
        assert client.get("/api/session/context").status_code == 401


class TestSwitching:
    def test_a_valid_switch_is_applied_and_remembered(self, client, db):
        sess, cursor = login_with_context(client, db)
        response = client.post(
            "/api/session/context", json={"role": "ANALYST", "warehouse": "BIG_WH"}
        )
        assert response.status_code == 200
        assert response.json() == {"role": "ANALYST", "warehouse": "BIG_WH"}

        applied = " ".join(use_statements(cursor)).upper()
        assert "USE ROLE" in applied and "ANALYST" in applied
        assert "USE WAREHOUSE" in applied and "BIG_WH" in applied

        user = db.get(User, sess.user_id)
        db.refresh(user)
        assert (user.last_role, user.last_warehouse) == ("ANALYST", "BIG_WH")

    def test_the_users_own_spelling_does_not_matter(self, client, db):
        sess, _ = login_with_context(client, db)
        client.post("/api/session/context", json={"role": "analyst"})
        user = db.get(User, sess.user_id)
        db.refresh(user)
        # Stored as Snowflake spells it, not as the caller typed it.
        assert user.last_role == "ANALYST"

    def test_one_may_be_changed_without_the_other(self, client, db):
        sess, _ = login_with_context(client, db)
        client.post("/api/session/context", json={"role": "ANALYST"})
        client.post("/api/session/context", json={"warehouse": "BIG_WH"})
        user = db.get(User, sess.user_id)
        db.refresh(user)
        assert (user.last_role, user.last_warehouse) == ("ANALYST", "BIG_WH")

    def test_a_role_the_user_lacks_is_refused_before_the_connection(self, client, db):
        _, cursor = login_with_context(client, db)
        response = client.post("/api/session/context", json={"role": "NO_SUCH_ROLE"})
        assert response.status_code == 400
        assert use_statements(cursor) == []

    def test_a_warehouse_the_user_lacks_is_refused(self, client, db):
        _, cursor = login_with_context(client, db)
        assert client.post(
            "/api/session/context", json={"warehouse": "SOMEONE_ELSES_WH"}
        ).status_code == 400
        assert use_statements(cursor) == []

    def test_an_injected_identifier_never_reaches_the_connection(self, client, db):
        _, cursor = login_with_context(client, db)
        for attempt in ('X" OR 1=1--', "ANALYST; DROP TABLE users", "AN'ALYST"):
            assert client.post(
                "/api/session/context", json={"role": attempt}
            ).status_code == 400
        assert use_statements(cursor) == []

    def test_a_refused_switch_is_not_remembered(self, client, db):
        sess, _ = login_with_context(client, db)
        client.post("/api/session/context", json={"role": "NO_SUCH_ROLE"})
        user = db.get(User, sess.user_id)
        db.refresh(user)
        assert user.last_role is None


class TestAudit:
    def test_the_switch_is_recorded_without_data(self, client, db):
        from app.db.models import AuditEvent

        login_with_context(client, db)
        client.post("/api/session/context", json={"role": "ANALYST"})
        event = (
            db.query(AuditEvent).filter(AuditEvent.action == "session.context").one()
        )
        assert event.detail["role"] == "ANALYST"
        assert event.outcome == "ok"
