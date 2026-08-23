"""The audit trail: the funnels record, denials leak nothing."""

from app.db.models import AuditEvent
from app.snowflake.provider import get_cache
from tests.test_report_routes import sign_in, valid_definition
from tests.test_semantic_routes import ScriptedConnection


def events(db, action=None):
    q = db.query(AuditEvent)
    if action:
        q = q.filter(AuditEvent.action == action)
    return q.order_by(AuditEvent.ts).all()


class TestAudit:
    def test_report_lifecycle_is_recorded(self, client, db):
        sess = sign_in(client, db)
        db.commit()
        created = client.post("/api/reports", json={"definition": valid_definition()})
        report_id = created.json()["id"]
        client.get(f"/api/reports/{report_id}")
        client.delete(f"/api/reports/{report_id}")

        actions = [e.action for e in events(db)]
        assert "report.create" in actions
        assert "report.read" in actions
        assert "report.delete" in actions
        read = events(db, "report.read")[0]
        assert str(read.user_id) == str(sess.user_id)
        assert read.resource_id == report_id
        # Session correlation is a hash, never the cookie value itself.
        assert read.session_ref and sess.id not in read.session_ref

    def test_a_denied_access_records_without_leaking(self, client, db):
        sign_in(client, db, user="ALICE")
        db.commit()
        created = client.post("/api/reports", json={"definition": valid_definition()})
        report_id = created.json()["id"]

        # A second user, not a member of Alice's workspace.
        client.cookies.clear()
        sign_in(client, db, user="BOB")
        db.commit()
        response = client.get(f"/api/reports/{report_id}")
        assert response.status_code == 404

        denied = events(db, "access.denied")
        assert len(denied) == 1
        assert denied[0].outcome == "denied"
        assert denied[0].resource_id == report_id
        # Value-free: no report NAME anywhere on the event.
        assert denied[0].detail is None

    def test_token_mint_and_login_are_recorded(self, client, db):
        sess = sign_in(client, db)
        db.commit()
        get_cache().put(sess.id, ScriptedConnection(), rebuildable=False)
        minted = client.post("/api/connect/token")
        assert minted.status_code == 200

        mint = events(db, "token.mint")
        assert len(mint) == 1
        assert str(mint[0].user_id) == str(sess.user_id)
        # The token itself must never appear on the event.
        raw = minted.json()["token"]
        assert raw not in str(mint[0].detail)

    def test_events_carry_the_request_id(self, client, db):
        sign_in(client, db)
        db.commit()
        created = client.post(
            "/api/reports", json={"definition": valid_definition()},
            headers={"X-Request-ID": "trace-me-1234"},
        )
        assert created.status_code == 201
        create = events(db, "report.create")[0]
        assert create.request_id == "trace-me-1234"
