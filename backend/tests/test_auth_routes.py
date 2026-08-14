from urllib.parse import parse_qs, urlparse

from app.auth import oauth as oauth_mod
from app.auth.oauth import TokenResponse
from app.auth.sessions import SESSION_COOKIE, create_session
from app.snowflake import connect as sf_connect
from app.snowflake.provider import get_cache
from tests.fakes import FakeConnection

OAUTH_ENV = {
    "SEMANTICUI_AUTH_MODE": "oauth",
    "SEMANTICUI_SNOWFLAKE_ACCOUNT": "myorg-myaccount",
    "SEMANTICUI_OAUTH_CLIENT_ID": "cid",
    "SEMANTICUI_OAUTH_CLIENT_SECRET": "csecret",
}


def test_config_reports_auth_mode(client):
    r = client.get("/api/config")
    assert r.status_code == 200
    assert r.json() == {"authMode": "dev"}


def test_me_without_cookie_is_401(client):
    r = client.get("/api/me")
    assert r.status_code == 401
    assert r.json()["code"] == "AUTH_EXPIRED"


def test_me_with_session(client, db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    r = client.get("/api/me")
    assert r.status_code == 200
    assert r.json() == {
        "snowflakeUser": "ALICE", "snowflakeAccount": "ACME", "mode": "dev"
    }


def test_oauth_login_disabled_in_dev_mode(client):
    r = client.get("/auth/login", follow_redirects=False)
    assert r.status_code == 400
    assert r.json()["code"] == "AUTH_FAILED"


def test_oauth_login_redirects_to_snowflake(make_client):
    client = make_client(**OAUTH_ENV)
    r = client.get("/auth/login", follow_redirects=False)
    assert r.status_code == 307
    url = urlparse(r.headers["location"])
    assert url.hostname == "myorg-myaccount.snowflakecomputing.com"
    assert parse_qs(url.query)["client_id"] == ["cid"]


def test_oauth_callback_creates_session_and_caches_conn(make_client, db, monkeypatch):
    client = make_client(**OAUTH_ENV)

    class StubOAuth:
        def exchange_code(self, code):
            assert code == "the-code"
            return TokenResponse("at-1", "rt-1", 600)

    conn = FakeConnection()
    monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
    monkeypatch.setattr(oauth_mod, "consume_state", lambda s: s == "good-state")
    monkeypatch.setattr(sf_connect, "connect_oauth", lambda token: conn)
    monkeypatch.setattr(sf_connect, "probe_identity", lambda c: ("ACME", "ALICE"))

    r = client.get(
        "/auth/callback",
        params={"code": "the-code", "state": "good-state"},
        follow_redirects=False,
    )
    assert r.status_code == 303
    assert r.headers["location"] == "/"
    sid = client.cookies.get(SESSION_COOKIE)
    assert sid
    from app.auth.sessions import get_active_session
    sess = get_active_session(db, sid)
    assert sess is not None and sess.mode == "oauth"
    assert get_cache().acquire(db, sess).conn is conn


def test_oauth_callback_rejects_bad_state(make_client, monkeypatch):
    client = make_client(**OAUTH_ENV)
    monkeypatch.setattr(oauth_mod, "consume_state", lambda s: False)
    r = client.get(
        "/auth/callback", params={"code": "c", "state": "bad"}, follow_redirects=False
    )
    assert r.status_code == 401
    assert r.json()["code"] == "AUTH_FAILED"


def test_logout_destroys_session(client, db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    get_cache().put(sess.id, FakeConnection())
    client.cookies.set(SESSION_COOKIE, sess.id)
    r = client.post("/auth/logout")
    assert r.status_code == 200
    from app.auth.sessions import get_active_session
    assert get_active_session(db, sess.id) is None
