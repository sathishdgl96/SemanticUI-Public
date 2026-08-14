import threading
from datetime import datetime, timedelta, timezone

import pytest

from app.auth import oauth as oauth_mod
from app.auth.crypto import decrypt_token
from app.auth.oauth import OAuthRefreshError, TokenResponse
from app.auth.sessions import create_session
from app.db.models import DbSession
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


def test_concurrent_acquire_same_session_leaks_nothing(db_factory, monkeypatch):
    setup_db = db_factory()
    sess = create_session(
        setup_db, account="ACME", user="ALICE", mode="oauth",
        access_token="at-1", refresh_token="rt-1",
        access_expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )
    session_id = sess.id
    setup_db.close()

    barrier = threading.Barrier(2)
    created: list[FakeConnection] = []
    created_lock = threading.Lock()

    def fake_connect_oauth(token):
        conn = FakeConnection()
        with created_lock:
            created.append(conn)
        barrier.wait()
        return conn

    monkeypatch.setattr(sf_connect, "connect_oauth", fake_connect_oauth)

    # Load each thread's own DbSession up front (sequentially, on the main
    # thread) so the racing threads below never touch the shared sqlite
    # connection concurrently -- the race under test is purely in the
    # in-memory cache/barrier logic, not database access.
    db1 = db_factory()
    db2 = db_factory()
    sess1 = db1.get(DbSession, session_id)
    sess2 = db2.get(DbSession, session_id)

    cache = make_cache()
    results = []
    results_lock = threading.Lock()

    def worker(thread_db, thread_sess):
        entry = cache.acquire(thread_db, thread_sess)
        with results_lock:
            results.append(entry)

    t1 = threading.Thread(target=worker, args=(db1, sess1))
    t2 = threading.Thread(target=worker, args=(db2, sess2))
    t1.start()
    t2.start()
    t1.join(timeout=10)
    t2.join(timeout=10)
    db1.close()
    db2.close()

    assert not t1.is_alive() and not t2.is_alive()
    assert len(created) == 2
    assert len(results) == 2
    assert results[0].conn is results[1].conn
    closed_flags = sorted(c.closed for c in created)
    assert closed_flags == [False, True]


def test_sweep_skips_busy_entries(db):
    now = [1000.0]
    cache = make_cache(clock=lambda: now[0])
    conn = FakeConnection()
    cache.put("sid-1", conn)
    entry = cache._entries["sid-1"]
    entry.lock.acquire()
    now[0] += 901
    assert cache.sweep() == 0
    assert conn.closed is False
    entry.lock.release()
    assert cache.sweep() == 1
    assert conn.closed is True
