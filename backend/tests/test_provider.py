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
from app.snowflake.provider import CacheEntry, ConnectionCache
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
        sf_connect, "connect_oauth", lambda token, user=None, role=None, account=None: calls.append(token) or FakeConnection()
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
        sf_connect, "connect_oauth", lambda token, user=None, role=None, account=None: used.append(token) or FakeConnection()
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

    def fake_connect_oauth(token, user=None, role=None, account=None):
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


def test_enforce_cap_skips_busy_entries(db):
    now = [1000.0]
    cache = make_cache(clock=lambda: now[0], max_size=2)
    busy = FakeConnection()
    cache.put("sid-busy", busy)
    entry = cache._entries["sid-busy"]
    entry.lock.acquire()
    now[0] += 1
    other = FakeConnection()
    cache.put("sid-2", other)
    now[0] += 1
    third = FakeConnection()
    # Adding a third entry pushes the cache over cap (2). The oldest entry
    # (sid-busy) is mid-query (lock held) and must not be evicted; the
    # next-oldest free entry (sid-2) should be evicted instead.
    cache.put("sid-3", third)

    assert busy.closed is False
    assert "sid-busy" in cache._entries
    assert cache._entries["sid-busy"].conn is busy
    assert other.closed is True
    assert "sid-2" not in cache._entries
    assert third.closed is False
    assert "sid-3" in cache._entries

    entry.lock.release()


def test_enforce_cap_leaves_cache_over_cap_when_all_busy(db):
    # Every entry over cap is mid-query (lock held). Exercise
    # _enforce_cap_locked directly: put() always inserts its new entry
    # unlocked, so the "every candidate is busy" case can't be reached
    # through the public put()/acquire() API alone.
    cache = make_cache(max_size=1)
    first, second = FakeConnection(), FakeConnection()
    cache._entries["sid-1"] = CacheEntry(conn=first, last_used=1000.0)
    cache._entries["sid-2"] = CacheEntry(conn=second, last_used=1001.0)
    cache._entries["sid-1"].lock.acquire()
    cache._entries["sid-2"].lock.acquire()

    with cache._lock:
        to_close = cache._enforce_cap_locked()

    assert to_close == []
    assert first.closed is False
    assert second.closed is False
    assert len(cache._entries) == 2


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


# --- idle eviction must not log out sessions that cannot rebuild -----------
# An OAuth entry can be rebuilt silently from its stored refresh token, so
# evicting it when idle costs nothing. A dev or key-pair entry IS the only
# credential: evicting it forces the user through a fresh SSO/PEM login. The
# idle sweep must therefore hold non-rebuildable connections for as long as
# their session is valid, rather than the much shorter connection TTL.


def test_sweep_holds_non_rebuildable_entries_past_the_idle_ttl(db):
    now = [1000.0]
    cache = ConnectionCache(
        idle_ttl=900, max_size=10, clock=lambda: now[0], retain_ttl=28800
    )
    conn = FakeConnection()
    cache.put("sid-dev", conn, rebuildable=False)
    now[0] += 901
    assert cache.sweep() == 0
    assert conn.closed is False


def test_sweep_still_evicts_non_rebuildable_entries_once_the_session_expires(db):
    now = [1000.0]
    cache = ConnectionCache(
        idle_ttl=900, max_size=10, clock=lambda: now[0], retain_ttl=28800
    )
    conn = FakeConnection()
    cache.put("sid-dev", conn, rebuildable=False)
    now[0] += 28801
    assert cache.sweep() == 1
    assert conn.closed is True


def test_sweep_still_evicts_rebuildable_entries_at_the_idle_ttl(db):
    now = [1000.0]
    cache = ConnectionCache(
        idle_ttl=900, max_size=10, clock=lambda: now[0], retain_ttl=28800
    )
    conn = FakeConnection()
    cache.put("sid-oauth", conn, rebuildable=True)
    now[0] += 901
    assert cache.sweep() == 1
    assert conn.closed is True


def test_oauth_acquire_marks_its_entry_rebuildable(db, monkeypatch):
    sess = create_session(
        db, account="ACME", user="ALICE", mode="oauth",
        access_token="at-1", refresh_token="rt-1",
        access_expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )
    monkeypatch.setattr(sf_connect, "connect_oauth", lambda token, user=None, role=None, account=None: FakeConnection())
    cache = ConnectionCache(idle_ttl=900, max_size=10, retain_ttl=28800)
    entry = cache.acquire(db, sess)
    assert entry.rebuildable is True


def _oauth_session(db, minutes_left=10):
    return create_session(
        db, account="ACME", user="ALICE", mode="oauth",
        access_token="at-1", refresh_token="rt-1",
        access_expires_at=datetime.now(timezone.utc) + timedelta(minutes=minutes_left),
    )


class FlakyThenFine:
    """A body that fails like a query on a dead session, once."""

    def __init__(self, failures=1):
        self.failures = failures
        self.seen: list[object] = []

    def __call__(self, entry):
        self.seen.append(entry.conn)
        if self.failures:
            self.failures -= 1
            raise AuthExpiredError("OAuth access token expired")
        return "rows"


def test_run_heals_an_oauth_session_snowflake_says_has_expired(db, monkeypatch):
    # The token is nominally good for ten more minutes -- Snowflake has just
    # said otherwise. The dead connection is dropped, a NEW token is fetched
    # anyway, and the body runs again on the new connection. The caller
    # sees only the answer.
    sess = _oauth_session(db)
    refreshed = []

    class StubOAuth:
        def refresh(self, refresh_token):
            refreshed.append(refresh_token)
            return TokenResponse("at-2", "rt-2", 600)

    monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
    built = []
    monkeypatch.setattr(
        sf_connect, "connect_oauth",
        lambda token, user=None, role=None, account=None: built.append(token) or FakeConnection(),
    )
    cache = make_cache()
    dead = FakeConnection()
    cache.put(sess.id, dead)

    body = FlakyThenFine()
    assert cache.run(db, sess, body) == "rows"

    assert body.seen[0] is dead and body.seen[1] is not dead
    assert dead.closed is True
    assert refreshed == ["rt-1"]
    assert built == ["at-2"]
    assert cache.acquire(db, sess).conn is body.seen[1]


def test_run_gives_up_after_one_rebuild(db, monkeypatch):
    sess = _oauth_session(db)

    class StubOAuth:
        def refresh(self, refresh_token):
            return TokenResponse("at-2", "rt-2", 600)

    monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
    monkeypatch.setattr(
        sf_connect, "connect_oauth",
        lambda token, user=None, role=None, account=None: FakeConnection(),
    )
    cache = make_cache()
    cache.put(sess.id, FakeConnection())
    body = FlakyThenFine(failures=2)
    with pytest.raises(AuthExpiredError):
        cache.run(db, sess, body)
    assert len(body.seen) == 2


def test_run_on_a_dev_session_discards_and_asks_for_sign_in(db):
    # Nothing to rebuild from, so the answer is a sign-in -- but the dead
    # connection is dropped, not handed out again on the next request.
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    cache = make_cache()
    dead = FakeConnection()
    cache.put(sess.id, dead)
    body = FlakyThenFine()
    with pytest.raises(AuthExpiredError):
        cache.run(db, sess, body)
    assert len(body.seen) == 1
    assert dead.closed is True
    with pytest.raises(AuthExpiredError):
        cache.acquire(db, sess)


def test_run_holds_the_entry_lock_around_the_body_unless_told_not_to(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    cache = make_cache()
    cache.put(sess.id, FakeConnection())
    held = []
    cache.run(db, sess, lambda entry: held.append(entry.lock.locked()))
    cache.run(db, sess, lambda entry: held.append(entry.lock.locked()), locked=False)
    assert held == [True, False]


def test_rebuilt_connection_runs_as_the_remembered_role(db, monkeypatch):
    # A connection rebuilt after the token expired must pick up where the
    # old one was, or the next query runs in the token's default role.
    from app.db.models import User

    sess = _oauth_session(db, minutes_left=-1)
    user = db.get(User, sess.user_id)
    user.last_role = "ANALYST"
    user.last_warehouse = "WH_SMALL"
    db.commit()

    class StubOAuth:
        def refresh(self, refresh_token):
            return TokenResponse("at-2", "rt-2", 600)

    monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
    conn = FakeConnection()
    monkeypatch.setattr(
        sf_connect, "connect_oauth",
        lambda token, user=None, role=None, account=None: conn,
    )
    make_cache().acquire(db, sess)
    assert 'USE ROLE "ANALYST"' in conn.cursor().executed
    assert 'USE WAREHOUSE "WH_SMALL"' in conn.cursor().executed


def _jwt_with(payload: dict) -> str:
    import base64
    import json

    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"eyJhbGciOiJub25lIn0.{body}."


def test_rebuild_presents_the_tokens_login_name_not_the_stored_user_name(db, monkeypatch):
    # Signed in through an identity provider, the token names the person
    # by their login name (an email); CURRENT_USER() then reports the
    # Snowflake user NAME (a short handle). A rebuild that sent the NAME
    # alongside a token for the email was refused with 390309 -- "the user
    # you were trying to authenticate as differs from the user tied to the
    # access token" -- the first time the original token expired.
    token = _jwt_with({"upn": "sathish@corp.example", "sub": "x"})
    sess = create_session(
        db, account="ACME", user="SNAGARAJ", mode="oauth",
        access_token="at-old", refresh_token="rt-1",
        access_expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
    )

    class StubOAuth:
        def refresh(self, refresh_token):
            return TokenResponse(token, "rt-2", 600)

    monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
    presented = []

    def fake_connect(token_, user=None, role=None, account=None):
        presented.append(user)
        return FakeConnection()

    monkeypatch.setattr(sf_connect, "connect_oauth", fake_connect)
    make_cache().acquire(db, sess)
    assert presented == ["sathish@corp.example"]


def test_a_rebuild_snowflake_refuses_is_an_api_error_not_a_crash(db, monkeypatch):
    from snowflake.connector.errors import DatabaseError

    sess = create_session(
        db, account="ACME", user="ALICE", mode="oauth",
        access_token="at-1", refresh_token="rt-1",
        access_expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )

    def refuse(token, user=None, role=None, account=None):
        raise DatabaseError(
            msg="The user you were trying to authenticate as differs from the user "
            "tied to the access token.",
            errno=390309,
            sqlstate="08001",
        )

    monkeypatch.setattr(sf_connect, "connect_oauth", refuse)
    # A connection-was-not-established refusal is a sign-in, not a 500.
    with pytest.raises(AuthExpiredError):
        make_cache().acquire(db, sess)
