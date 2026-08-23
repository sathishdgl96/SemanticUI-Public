from app.auth.sessions import create_session
from app.snowflake.provider import ConnectionCache
from tests.fakes import FakeConnection


DESCRIBE_A = {"tables": [{"name": "ORDERS"}], "relationships": [],
              "dimensions": [], "metrics": [], "facts": []}


def make_entry(cache, db, account="ACME", user="ALICE"):
    sess = create_session(db, account=account, user=user, mode="dev")
    conn = FakeConnection()
    cache.put(sess.id, conn, rebuildable=False)
    return sess, cache.acquire(db, sess)


def test_describe_is_fetched_once_and_then_served_from_cache(db, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.snowflake.provider.describe_semantic_view",
        lambda conn, d, s, n: calls.append((d, s, n)) or DESCRIBE_A,
    )
    cache = ConnectionCache(idle_ttl=900, max_size=10, retain_ttl=28800)
    _sess, entry = make_entry(cache, db)

    first = cache.describe(entry, "ANALYTICS", "PUBLIC", "SALES")
    second = cache.describe(entry, "ANALYTICS", "PUBLIC", "SALES")
    assert first == DESCRIBE_A and second == DESCRIBE_A
    assert len(calls) == 1, "second call should have been served from the cache"


def test_a_different_view_is_a_different_cache_key(db, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.snowflake.provider.describe_semantic_view",
        lambda conn, d, s, n: calls.append(n) or DESCRIBE_A,
    )
    cache = ConnectionCache(idle_ttl=900, max_size=10, retain_ttl=28800)
    _sess, entry = make_entry(cache, db)
    cache.describe(entry, "ANALYTICS", "PUBLIC", "SALES")
    cache.describe(entry, "ANALYTICS", "PUBLIC", "OPS")
    assert calls == ["SALES", "OPS"]


def test_cache_expires_after_the_ttl(db, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.snowflake.provider.describe_semantic_view",
        lambda conn, d, s, n: calls.append(n) or DESCRIBE_A,
    )
    now = [1000.0]
    cache = ConnectionCache(
        idle_ttl=900, max_size=10, retain_ttl=28800, clock=lambda: now[0]
    )
    _sess, entry = make_entry(cache, db)
    cache.describe(entry, "ANALYTICS", "PUBLIC", "SALES")
    now[0] += 301  # past the 300s default
    cache.describe(entry, "ANALYTICS", "PUBLIC", "SALES")
    assert len(calls) == 2


def test_force_and_invalidate_refetch(db, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.snowflake.provider.describe_semantic_view",
        lambda conn, d, s, n: calls.append(n) or DESCRIBE_A,
    )
    cache = ConnectionCache(idle_ttl=900, max_size=10, retain_ttl=28800)
    _sess, entry = make_entry(cache, db)
    cache.describe(entry, "ANALYTICS", "PUBLIC", "SALES")
    cache.describe(entry, "ANALYTICS", "PUBLIC", "SALES", force=True)
    assert len(calls) == 2
    cache.invalidate_describe(entry, "ANALYTICS", "PUBLIC", "SALES")
    cache.describe(entry, "ANALYTICS", "PUBLIC", "SALES")
    assert len(calls) == 3


def test_two_sessions_never_share_a_describe(db, monkeypatch):
    """The whole point of putting the cache inside the entry."""
    calls = []
    monkeypatch.setattr(
        "app.snowflake.provider.describe_semantic_view",
        lambda conn, d, s, n: calls.append(n) or DESCRIBE_A,
    )
    cache = ConnectionCache(idle_ttl=900, max_size=10, retain_ttl=28800)
    _a, entry_a = make_entry(cache, db, user="ALICE")
    _b, entry_b = make_entry(cache, db, user="BOB")
    cache.describe(entry_a, "ANALYTICS", "PUBLIC", "SALES")
    cache.describe(entry_b, "ANALYTICS", "PUBLIC", "SALES")
    assert len(calls) == 2, "Bob must not be served Alice's cached catalog"
    assert entry_a.describe_cache is not entry_b.describe_cache
