import pytest

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


def test_keypair_login_succeeds_and_stores_nothing(client, db, monkeypatch):
    from tests.test_connect import _make_pem

    pem = _make_pem()
    conn = FakeConnection()
    seen = {}
    monkeypatch.setattr(
        sf_connect, "connect_dev", lambda **kw: seen.update(kw) or conn
    )
    monkeypatch.setattr(sf_connect, "probe_identity", lambda c: ("ACME", "ALICE"))

    r = client.post(
        "/auth/dev-login",
        json={
            "account": "acct",
            "user": "alice",
            "authenticator": "keypair",
            "private_key_pem": pem,
            "private_key_passphrase": None,
        },
    )
    assert r.status_code == 200
    assert seen["private_key_pem"] == pem
    # the PEM must never come back out
    assert "PRIVATE KEY" not in r.text
    # ...and must never be persisted
    from app.db.models import DbSession
    from sqlalchemy import select

    for row in db.scalars(select(DbSession)).all():
        assert row.access_token_enc is None
        assert row.refresh_token_enc is None


def test_method_not_enabled_is_rejected(make_client):
    client = make_client(
        SEMANTICUI_AUTH_MODE="dev",
        SEMANTICUI_DIRECT_LOGIN_METHODS='["keypair"]',
    )
    r = client.post(
        "/auth/dev-login",
        json={"account": "a", "user": "u", "authenticator": "password", "password": "p"},
    )
    assert r.status_code == 400
    assert r.json()["code"] == "AUTH_FAILED"


def test_config_reports_direct_login_methods(client):
    body = client.get("/api/config").json()
    assert body["authMode"] == "dev"
    assert "keypair" in body["directLoginMethods"]


def test_keypair_login_rejects_foreign_account_when_pinned(make_client, monkeypatch):
    from tests.test_connect import _make_pem

    client = make_client(
        SEMANTICUI_AUTH_MODE="dev",
        SEMANTICUI_SNOWFLAKE_ACCOUNT="myorg-myaccount",
    )
    pem = _make_pem()
    calls = []
    monkeypatch.setattr(
        sf_connect, "connect_dev", lambda **kw: calls.append(kw) or FakeConnection()
    )
    r = client.post(
        "/auth/dev-login",
        json={
            "account": "some-other-account",
            "user": "alice",
            "authenticator": "keypair",
            "private_key_pem": pem,
            "private_key_passphrase": None,
        },
    )
    assert r.status_code == 400
    assert r.json()["code"] == "AUTH_FAILED"
    # Must reject before ever opening a Snowflake connection to the
    # foreign account.
    assert calls == []


def test_keypair_login_allows_matching_account_case_insensitive(make_client, monkeypatch):
    from tests.test_connect import _make_pem

    client = make_client(
        SEMANTICUI_AUTH_MODE="dev",
        SEMANTICUI_SNOWFLAKE_ACCOUNT="myorg-myaccount",
    )
    pem = _make_pem()
    monkeypatch.setattr(sf_connect, "connect_dev", lambda **kw: FakeConnection())
    monkeypatch.setattr(sf_connect, "probe_identity", lambda c: ("MYORG-MYACCOUNT", "ALICE"))
    r = client.post(
        "/auth/dev-login",
        json={
            "account": "MyOrg-MyAccount",
            "user": "alice",
            "authenticator": "keypair",
            "private_key_pem": pem,
            "private_key_passphrase": None,
        },
    )
    assert r.status_code == 200


def test_keypair_login_allows_any_account_when_unpinned(client, monkeypatch):
    from tests.test_connect import _make_pem

    pem = _make_pem()
    monkeypatch.setattr(sf_connect, "connect_dev", lambda **kw: FakeConnection())
    monkeypatch.setattr(sf_connect, "probe_identity", lambda c: ("SOME-OTHER-ACCT", "ALICE"))
    r = client.post(
        "/auth/dev-login",
        json={
            "account": "some-other-acct",
            "user": "alice",
            "authenticator": "keypair",
            "private_key_pem": pem,
            "private_key_passphrase": None,
        },
    )
    assert r.status_code == 200


def test_dev_login_closes_connection_when_probe_identity_fails(client, monkeypatch):
    # If anything after connect_dev() raises (probe_identity, create_session
    # -- e.g. Postgres is down), the just-opened Snowflake connection was
    # never handed to the cache, so nothing else would ever close it. A
    # systematic failure here would leak one Snowflake session per login
    # attempt.
    conn = FakeConnection()
    monkeypatch.setattr(sf_connect, "connect_dev", lambda **kw: conn)

    def boom(c):
        raise RuntimeError("probe failed")

    monkeypatch.setattr(sf_connect, "probe_identity", boom)
    # The TestClient re-raises unhandled server exceptions by default
    # (rather than surfacing the envelope response); what this test cares
    # about is that the connection was closed either way.
    with pytest.raises(RuntimeError):
        client.post(
            "/auth/dev-login",
            json={"account": "acct", "user": "alice", "authenticator": "externalbrowser"},
        )
    assert conn.closed is True


def test_oversized_pem_validation_error_does_not_echo_key_material(client):
    marker = "MARKER-SECRET-KEY-MATERIAL-" + ("X" * 20000)
    r = client.post(
        "/auth/dev-login",
        json={
            "account": "acct",
            "user": "alice",
            "authenticator": "keypair",
            "private_key_pem": marker,
            "private_key_passphrase": None,
        },
    )
    assert r.status_code == 422
    assert marker not in r.text
    assert "PRIVATE KEY" not in r.text
