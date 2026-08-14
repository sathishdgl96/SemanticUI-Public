from app.snowflake import connect as sf_connect
from app.auth.sessions import SESSION_COOKIE
from tests.fakes import FakeConnection


def test_dev_login_happy_path(client, monkeypatch):
    conn = FakeConnection()
    seen = {}

    def fake_connect_dev(**kwargs):
        seen.update(kwargs)
        return conn

    monkeypatch.setattr(sf_connect, "connect_dev", fake_connect_dev)
    monkeypatch.setattr(sf_connect, "probe_identity", lambda c: ("ACME", "ALICE"))
    r = client.post(
        "/auth/dev-login",
        json={"account": "acct", "user": "alice", "authenticator": "externalbrowser"},
    )
    assert r.status_code == 200
    assert r.json() == {
        "snowflakeUser": "ALICE", "snowflakeAccount": "ACME", "mode": "dev"
    }
    assert seen["authenticator"] == "externalbrowser"
    assert client.cookies.get(SESSION_COOKIE)
    me = client.get("/api/me")
    assert me.status_code == 200


def test_dev_login_failure_is_auth_failed(client, monkeypatch):
    def boom(**kwargs):
        raise RuntimeError("250001: could not connect")

    monkeypatch.setattr(sf_connect, "connect_dev", boom)
    r = client.post(
        "/auth/dev-login",
        json={"account": "acct", "user": "alice", "authenticator": "password",
              "password": "wrong"},
    )
    assert r.status_code == 401
    assert r.json()["code"] == "AUTH_FAILED"


def test_dev_login_disabled_in_oauth_mode(make_client):
    client = make_client(
        SEMANTICUI_AUTH_MODE="oauth",
        SEMANTICUI_SNOWFLAKE_ACCOUNT="myorg-myaccount",
        SEMANTICUI_OAUTH_CLIENT_ID="cid",
        SEMANTICUI_OAUTH_CLIENT_SECRET="csecret",
    )
    r = client.post(
        "/auth/dev-login",
        json={"account": "acct", "user": "alice", "authenticator": "externalbrowser"},
    )
    assert r.status_code == 400
    assert r.json()["code"] == "AUTH_FAILED"
