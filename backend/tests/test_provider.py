from datetime import datetime, timedelta, timezone

import pytest

from app.auth import oauth as oauth_mod
from app.auth.crypto import decrypt_token
from app.auth.oauth import OAuthRefreshError, TokenResponse
from app.auth.sessions import create_session
from app.errors import AuthExpiredError
from app.snowflake import connect as sf_connect
from app.snowflake.provider import ConnectionCache
from tests.fakes import FakeConnection


def make_cache(clock=None, max_size=10):
    kwargs = {"idle_ttl": 900, "max_size": max_size}
    if clock is not None:
        kwargs["clock"] = clock
    return ConnectionCache(**kwargs)


def test_dev_put_then_acquire_roundtrip(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    cache = make_cache()
    conn = FakeConnection()
    cache.put(sess.id, conn)
    entry = cache.acquire(db, sess)
    assert entry.conn is conn


def test_dev_missing_or_dead_connection_raises(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    cache = make_cache()
    with pytest.raises(AuthExpiredError):
        cache.acquire(db, sess)
    dead = FakeConnection()
    dead.closed = True
    cache.put(sess.id, dead)
    with pytest.raises(AuthExpiredError):
        cache.acquire(db, sess)


def test_oauth_builds_once_and_reuses(db, monkeypatch):
    sess = create_session(
        db, account="ACME", user="ALICE", mode="oauth",
        access_token="at-1", refresh_token="rt-1",
        access_expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )
    calls = []
    monkeypatch.setattr(
        sf_connect, "connect_oauth", lambda token: calls.append(token) or FakeConnection()
    )
    cache = make_cache()
    e1 = cache.acquire(db, sess)
    e2 = cache.acquire(db, sess)
    assert e1.conn is e2.conn
    assert calls == ["at-1"]


def test_oauth_refreshes_expired_token(db, monkeypatch):
    sess = create_session(
        db, account="ACME", user="ALICE", mode="oauth",
        access_token="at-old", refresh_token="rt-old",
        access_expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
    )

    class StubOAuth:
        def refresh(self, refresh_token):
            assert refresh_token == "rt-old"
            return TokenResponse("at-new", "rt-new", 600)

    monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
    used = []
    monkeypatch.setattr(
        sf_connect, "connect_oauth", lambda token: used.append(token) or FakeConnection()
    )
    cache = make_cache()
    cache.acquire(db, sess)
    assert used == ["at-new"]
    assert decrypt_token(sess.access_token_enc) == "at-new"
    assert decrypt_token(sess.refresh_token_enc) == "rt-new"


def test_oauth_refresh_failure_is_auth_expired(db, monkeypatch):
    sess = create_session(
        db, account="ACME", user="ALICE", mode="oauth",
        access_token="at-old", refresh_token="rt-old",
        access_expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
    )

    class StubOAuth:
        def refresh(self, refresh_token):
            raise OAuthRefreshError("invalid_grant")

    monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
    with pytest.raises(AuthExpiredError):
        make_cache().acquire(db, sess)


def test_sweep_closes_idle_connections(db):
    now = [1000.0]
    cache = make_cache(clock=lambda: now[0])
    conn = FakeConnection()
    cache.put("sid-1", conn)
    assert cache.sweep() == 0
    now[0] += 901
    assert cache.sweep() == 1
    assert conn.closed is True


def test_lru_eviction_at_max_size(db):
    cache = make_cache(max_size=1)
    first, second = FakeConnection(), FakeConnection()
    cache.put("sid-1", first)
    cache.put("sid-2", second)
    assert first.closed is True
