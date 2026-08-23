"""Structured logging and correlation, plus the never-log-data rule.

The hygiene test at the bottom is the point of the module: it exercises
representative authenticated flows and then asserts that nothing
resembling a secret ever reached a log record. Habits drift; this does
not.
"""

import json
import logging

from app.logging import (
    ContextFilter,
    JsonFormatter,
    request_id_var,
    set_user,
    setup_logging,
)


class TestFormat:
    def test_json_lines_carry_context_and_extras(self):
        record = logging.LogRecord("app.request", logging.INFO, __file__, 1,
                                   "request", (), None)
        token = request_id_var.set("rid1234")
        set_user("u-99")
        try:
            ContextFilter().filter(record)
        finally:
            request_id_var.reset(token)
        record.status = 200
        record.duration_ms = 12
        out = json.loads(JsonFormatter().format(record))
        assert out["msg"] == "request"
        assert out["request_id"] == "rid1234"
        assert out["user_id"] == "u-99"
        assert out["status"] == 200 and out["duration_ms"] == 12

    def test_setup_is_idempotent(self):
        setup_logging("json")
        setup_logging("json")
        root = logging.getLogger()
        assert len(root.handlers) == 1


class TestRequestMiddleware:
    def test_every_response_carries_a_request_id(self, client):
        response = client.get("/api/branding")
        assert response.headers["X-Request-ID"]

    def test_an_inbound_id_is_honoured(self, client):
        response = client.get("/api/branding",
                              headers={"X-Request-ID": "proxy-abc"})
        assert response.headers["X-Request-ID"] == "proxy-abc"

    def test_one_summary_line_per_request(self, client, caplog):
        with caplog.at_level(logging.INFO, logger="app.request"):
            client.get("/api/branding")
        lines = [r for r in caplog.records if r.name == "app.request"]
        assert len(lines) == 1
        assert lines[0].status == 200
        assert lines[0].path == "/api/branding"
        assert lines[0].request_id


class TestNeverLogData:
    def test_secrets_never_reach_log_records(self, client, db, caplog, monkeypatch):
        """Sign in, mint a connect token, use the feed -- then sweep every
        captured record for token material and credentials."""
        from app.snowflake.provider import get_cache
        from tests.test_report_routes import sign_in
        from tests.test_semantic_routes import ScriptedConnection

        with caplog.at_level(logging.DEBUG):
            sess = sign_in(client, db)
            db.commit()
            get_cache().put(sess.id, ScriptedConnection(), rebuildable=False)
            minted = client.post("/api/connect/token")
            token = minted.json()["token"]
            client.get("/api/reports")

        blob = " ".join(
            f"{r.getMessage()} {vars(r)}" for r in caplog.records
        )
        assert token not in blob
        assert "xlt_" not in blob
        assert "Password" not in blob and "password" not in blob
