import snowflake.connector

from app.snowflake import connect as sf_connect


def test_connect_oauth_passes_token_and_timeout(monkeypatch):
    seen = {}

    def fake_connect(**kwargs):
        seen.update(kwargs)
        return "CONN"

    monkeypatch.setenv("SEMANTICUI_SNOWFLAKE_ACCOUNT", "myorg-myaccount")
    from app.config import get_settings
    get_settings.cache_clear()
    monkeypatch.setattr(snowflake.connector, "connect", fake_connect)
    conn = sf_connect.connect_oauth("tok-123")
    get_settings.cache_clear()

    assert conn == "CONN"
    assert seen["account"] == "myorg-myaccount"
    assert seen["authenticator"] == "oauth"
    assert seen["token"] == "tok-123"
    assert seen["session_parameters"]["STATEMENT_TIMEOUT_IN_SECONDS"] == 60


def test_connect_dev_externalbrowser_and_password(monkeypatch):
    calls = []

    def fake_connect(**kwargs):
        calls.append(kwargs)
        return "CONN"

    monkeypatch.setattr(snowflake.connector, "connect", fake_connect)
    sf_connect.connect_dev(account="acct", user="alice", authenticator="externalbrowser")
    sf_connect.connect_dev(
        account="acct", user="alice", authenticator="password", password="pw"
    )
    assert calls[0]["authenticator"] == "externalbrowser"
    assert "password" not in calls[0]
    assert calls[1]["password"] == "pw"
    assert "authenticator" not in calls[1]


class FakeIdentityCursor:
    def execute(self, sql):
        assert "CURRENT_ACCOUNT()" in sql and "CURRENT_USER()" in sql
        return self

    def fetchone(self):
        return ("ACME", "ALICE")

    def close(self):
        pass


class FakeIdentityConn:
    def cursor(self):
        return FakeIdentityCursor()


def test_probe_identity():
    assert sf_connect.probe_identity(FakeIdentityConn()) == ("ACME", "ALICE")
