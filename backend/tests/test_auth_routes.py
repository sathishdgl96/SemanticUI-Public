from urllib.parse import parse_qs, urlparse

import pytest

from app.auth import oauth as oauth_mod
from app.auth.oauth import OAUTH_STATE_COOKIE, TokenResponse
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
    body = r.json()
    assert body["authMode"] == "dev"
    assert set(body["directLoginMethods"]) == {"externalbrowser", "password", "keypair"}


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


def test_oauth_login_sets_httponly_state_cookie(make_client):
    client = make_client(**OAUTH_ENV)
    r = client.get("/auth/login", follow_redirects=False)
    set_cookie = r.headers.get("set-cookie", "")
    assert OAUTH_STATE_COOKIE in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=lax" in set_cookie.lower().replace("samesite=lax", "SameSite=lax")
    assert client.cookies.get(OAUTH_STATE_COOKIE)


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
    # Simulate the browser having received the state cookie from a prior
    # /auth/login redirect.
    client.cookies.set(OAUTH_STATE_COOKIE, "good-state")

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
    # The one-shot state cookie must not survive a successful login: the
    # response must re-issue it with an immediate expiry.
    set_cookie = r.headers.get("set-cookie", "")
    assert OAUTH_STATE_COOKIE in set_cookie
    assert "01 Jan 1970" in set_cookie or "Max-Age=0" in set_cookie


def test_oauth_callback_redirects_to_configured_post_login_url(
    make_client, db, monkeypatch
):
    client = make_client(
        **OAUTH_ENV, SEMANTICUI_POST_LOGIN_REDIRECT_URL="https://spa.example.com/app"
    )

    class StubOAuth:
        def exchange_code(self, code):
            return TokenResponse("at-1", "rt-1", 600)

    monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
    monkeypatch.setattr(oauth_mod, "consume_state", lambda s: s == "good-state")
    monkeypatch.setattr(sf_connect, "connect_oauth", lambda token: FakeConnection())
    monkeypatch.setattr(sf_connect, "probe_identity", lambda c: ("ACME", "ALICE"))
    client.cookies.set(OAUTH_STATE_COOKIE, "good-state")

    r = client.get(
        "/auth/callback",
        params={"code": "the-code", "state": "good-state"},
        follow_redirects=False,
    )
    assert r.status_code == 303
    assert r.headers["location"] == "https://spa.example.com/app"


def test_oauth_callback_rejects_bad_state(make_client, monkeypatch):
    client = make_client(**OAUTH_ENV)
    monkeypatch.setattr(oauth_mod, "consume_state", lambda s: False)
    client.cookies.set(OAUTH_STATE_COOKIE, "bad")
    r = client.get(
        "/auth/callback", params={"code": "c", "state": "bad"}, follow_redirects=False
    )
    assert r.status_code == 401
    assert r.json()["code"] == "AUTH_FAILED"


def test_oauth_callback_rejects_missing_state_cookie(make_client, monkeypatch):
    # Login CSRF: an attacker starts /auth/login, reads their own (live,
    # server-side-valid) state, and feeds a victim's browser this exact
    # callback URL. Without a browser-bound cookie tying the callback back
    # to whoever actually started the flow, the state value alone is
    # enough to complete the login -- so the callback must refuse to even
    # consult consume_state() when no cookie is present.
    client = make_client(**OAUTH_ENV)
    consumed = []
    monkeypatch.setattr(
        oauth_mod, "consume_state", lambda s: consumed.append(s) or True
    )
    r = client.get(
        "/auth/callback",
        params={"code": "c", "state": "victim-has-no-cookie"},
        follow_redirects=False,
    )
    assert r.status_code == 401
    assert r.json()["code"] == "AUTH_FAILED"
    assert consumed == []


def test_oauth_callback_rejects_mismatched_state_cookie(make_client, monkeypatch):
    client = make_client(**OAUTH_ENV)
    consumed = []
    monkeypatch.setattr(
        oauth_mod, "consume_state", lambda s: consumed.append(s) or True
    )
    client.cookies.set(OAUTH_STATE_COOKIE, "attackers-state")
    r = client.get(
        "/auth/callback",
        params={"code": "c", "state": "a-different-state"},
        follow_redirects=False,
    )
    assert r.status_code == 401
    assert r.json()["code"] == "AUTH_FAILED"
    assert consumed == []


def test_oauth_callback_deletes_state_cookie_on_rejection(make_client, monkeypatch):
    client = make_client(**OAUTH_ENV)
    monkeypatch.setattr(oauth_mod, "consume_state", lambda s: True)
    client.cookies.set(OAUTH_STATE_COOKIE, "mismatched")
    r = client.get(
        "/auth/callback",
        params={"code": "c", "state": "does-not-match"},
        follow_redirects=False,
    )
    assert r.status_code == 401
    set_cookie = r.headers.get("set-cookie", "")
    assert OAUTH_STATE_COOKIE in set_cookie
    # A deleted cookie is re-sent with an immediate expiry.
    assert "01 Jan 1970" in set_cookie or "Max-Age=0" in set_cookie


def test_oauth_callback_closes_connection_when_probe_identity_fails(
    make_client, monkeypatch
):
    # Same leak as the dev-login path: if probe_identity/create_session
    # raises after connect_oauth() succeeds, the connection was never
    # handed to the cache and must be closed explicitly or it leaks.
    client = make_client(**OAUTH_ENV)

    class StubOAuth:
        def exchange_code(self, code):
            return TokenResponse("at-1", "rt-1", 600)

    conn = FakeConnection()
    monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
    monkeypatch.setattr(oauth_mod, "consume_state", lambda s: True)
    monkeypatch.setattr(sf_connect, "connect_oauth", lambda token: conn)

    def boom(c):
        raise RuntimeError("probe failed")

    monkeypatch.setattr(sf_connect, "probe_identity", boom)
    client.cookies.set(OAUTH_STATE_COOKIE, "good-state")

    with pytest.raises(RuntimeError):
        client.get(
            "/auth/callback",
            params={"code": "c", "state": "good-state"},
            follow_redirects=False,
        )
    assert conn.closed is True


def test_logout_destroys_session(client, db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    get_cache().put(sess.id, FakeConnection())
    client.cookies.set(SESSION_COOKIE, sess.id)
    r = client.post("/auth/logout")
    assert r.status_code == 200
    from app.auth.sessions import get_active_session
    assert get_active_session(db, sess.id) is None
