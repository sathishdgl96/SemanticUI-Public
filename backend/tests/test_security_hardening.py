"""The A1 hardening set: headers, CSRF posture, throttling, guardrails."""

import pytest

from app.auth.throttle import SlidingWindow
from app.config import get_settings


class TestHeaders:
    def test_baseline_headers_on_api_responses(self, client):
        response = client.get("/api/branding")
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["Referrer-Policy"] == "same-origin"
        assert response.headers["X-Frame-Options"] == "DENY"
        assert response.headers["Cache-Control"] == "no-store"

    def test_hsts_only_in_production(self, client):
        assert "Strict-Transport-Security" not in client.get("/api/branding").headers


class TestCrossSiteRefusal:
    def test_a_cross_site_post_is_refused(self, client):
        response = client.post(
            "/api/reports", json={},
            headers={"Sec-Fetch-Site": "cross-site"},
        )
        assert response.status_code == 403

    def test_same_origin_and_headerless_clients_pass(self, client):
        # Same-origin browsers say so; non-browser clients (tests, curl,
        # Excel) send nothing. Neither is refused by the CSRF guard.
        for headers in ({"Sec-Fetch-Site": "same-origin"}, {}):
            response = client.post("/api/reports", json={}, headers=headers)
            assert response.status_code != 403


class TestThrottle:
    def test_budget_then_429_then_recovery(self):
        now = [0.0]
        window = SlidingWindow(limit=3, window=60, clock=lambda: now[0])
        key = "login:1.2.3.4:acme/alice"
        for _ in range(3):
            assert window.allowed(key)
            window.register_failure(key)
        assert not window.allowed(key)
        assert window.retry_after(key) > 0
        now[0] += 61
        assert window.allowed(key)

    def test_dev_login_returns_429_after_repeated_failures(self, client, monkeypatch):
        from app.auth import throttle as throttle_module
        from app.snowflake import connect as sf_connect

        monkeypatch.setattr(throttle_module, "_auth_window", SlidingWindow(limit=2))
        def refuse(**kwargs):
            raise RuntimeError("bad credentials")
        monkeypatch.setattr(sf_connect, "connect_dev", refuse)
        body = {"account": "acme", "user": "alice",
                "authenticator": "password", "password": "wrong"}
        assert client.post("/auth/dev-login", json=body).status_code == 401
        assert client.post("/auth/dev-login", json=body).status_code == 401
        assert client.post("/auth/dev-login", json=body).status_code == 429


class TestProductionGuardrails:
    def _production(self, monkeypatch, **overrides):
        values = {
            "environment": "production",
            "auth_mode": "oauth",
            "secret_key": "x" * 40,
            "snowflake_account": "acme",
            "oauth_client_id": "cid",
            "oauth_client_secret": "sec",
            "database_url": "postgresql+psycopg://app:pw@db.internal:5432/semanticui",
            "direct_login_methods": [],
        }
        values.update(overrides)
        return values

    def test_refuses_the_xmla_trace_flag(self, monkeypatch):
        from app.config import Settings

        monkeypatch.setenv("SEMANTICUI_XMLA_TRACE", "C:/tmp/wire.txt")
        with pytest.raises(Exception, match="XMLA_TRACE"):
            Settings(**self._production(monkeypatch))

    def test_refuses_a_localhost_database(self, monkeypatch):
        from app.config import Settings

        monkeypatch.delenv("SEMANTICUI_XMLA_TRACE", raising=False)
        with pytest.raises(Exception, match="localhost"):
            Settings(**self._production(
                monkeypatch,
                database_url="postgresql+psycopg://x@localhost:5432/d",
            ))

    def test_a_clean_production_config_passes(self, monkeypatch):
        from app.config import Settings

        monkeypatch.delenv("SEMANTICUI_XMLA_TRACE", raising=False)
        Settings(**self._production(monkeypatch))  # no raise
