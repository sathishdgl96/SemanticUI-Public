"""Self-healing XMLA connections.

The failure this guards against: a cached Snowflake connection dies
server-side (idle timeout, network change, laptop sleep) while
`is_closed()` still reports it open. Without these behaviours every
subsequent request fails identically until the user signs in again --
"Excel breaks randomly and stays broken":

* the cache discards an entry whose connection proved dead,
* the XMLA endpoint retries ONCE after a discard -- an OAuth session
  rebuilds silently, a dev session gets a clear "sign in again" fault,
* MSOLAP's habit of re-sending one rejected token in a burst does not
  exhaust the per-client auth throttle (only distinct bad tokens count),
* connections are opened with keep-alive so idle death is rare to begin
  with.
"""

import base64
from datetime import datetime, timedelta, timezone

import snowflake.connector
from snowflake.connector.errors import ProgrammingError

from app.auth import connect_token
from app.auth.sessions import create_session
from app.auth.throttle import SlidingWindow, auth_window
from app.errors import AuthExpiredError
from app.snowflake import connect as sf_connect
from app.snowflake.provider import get_cache
from tests.test_provider import make_cache
from tests.test_semantic_routes import ScriptedConnection
from tests.test_xmla_discover import discover_body
from tests.fakes import FakeConnection

SESSION_GONE = ProgrammingError(
    msg="Authentication token has expired. The user must authenticate again.",
    errno=390114,
    sqlstate="08001",
)


class DyingConnection(ScriptedConnection):
    """Reports open, but every statement fails like a server-side death."""

    def cursor(self):
        cur = super().cursor()
        original = cur.execute

        def die(sql, params=None):
            original(sql, params)
            raise SESSION_GONE

        cur.execute = die
        return cur


def basic_auth(token: str) -> dict:
    encoded = base64.b64encode(f"token:{token}".encode()).decode()
    return {"Authorization": f"Basic {encoded}"}


class TestDiscard:
    def test_discard_drops_the_dead_entry_and_closes_it(self, db):
        sess = create_session(db, account="ACME", user="ALICE", mode="dev")
        cache = make_cache()
        conn = FakeConnection()
        cache.put(sess.id, conn)
        entry = cache.acquire(db, sess)

        cache.discard(sess.id, entry)

        assert conn.closed
        try:
            cache.acquire(db, sess)
            raise AssertionError("expected AuthExpiredError")
        except AuthExpiredError:
            pass

    def test_discard_ignores_a_superseded_entry(self, db):
        """A slow request must not evict the rebuilt successor."""
        sess = create_session(db, account="ACME", user="ALICE", mode="dev")
        cache = make_cache()
        cache.put(sess.id, FakeConnection())
        stale = cache.acquire(db, sess)
        replacement = FakeConnection()
        cache.put(sess.id, replacement)

        cache.discard(sess.id, stale)

        assert not replacement.closed
        assert cache.acquire(db, sess).conn is replacement


class TestXmlaRetry:
    def test_oauth_rebuilds_silently_after_connection_death(
        self, client, db, monkeypatch
    ):
        sess = create_session(
            db, account="ACME", user="ALICE", mode="oauth",
            access_token="at-1", refresh_token="rt-1",
            access_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        raw, _ = connect_token.mint(db, sess)
        db.commit()
        dying = DyingConnection()
        get_cache().put(sess.id, dying)
        rebuilt = ScriptedConnection()
        monkeypatch.setattr(sf_connect, "connect_oauth", lambda token, user=None, role=None, account=None: rebuilt)

        response = client.post(
            "/xmla", content=discover_body("MDSCHEMA_CUBES"),
            headers={"Content-Type": "text/xml", **basic_auth(raw)},
        )

        assert response.status_code == 200
        assert "Fault" not in response.text
        assert "SALES" in response.text
        assert dying.closed

    def test_dev_reports_sign_in_again_and_discards(self, client, db):
        sess = create_session(db, account="ACME", user="ALICE", mode="dev")
        raw, _ = connect_token.mint(db, sess)
        db.commit()
        dying = DyingConnection()
        get_cache().put(sess.id, dying)

        response = client.post(
            "/xmla", content=discover_body("MDSCHEMA_CUBES"),
            headers={"Content-Type": "text/xml", **basic_auth(raw)},
        )

        # A clean SOAP fault telling the user what to do -- never a
        # generic "internal error", and never the same dead connection
        # left in the cache to fail the next request too.
        assert response.status_code == 200
        assert "Fault" in response.text
        assert "sign in" in response.text.lower()
        assert dying.closed

    def test_a_healthy_connection_is_untouched(self, client, db):
        sess = create_session(db, account="ACME", user="ALICE", mode="dev")
        raw, _ = connect_token.mint(db, sess)
        db.commit()
        conn = ScriptedConnection()
        get_cache().put(sess.id, conn)

        response = client.post(
            "/xmla", content=discover_body("MDSCHEMA_CUBES"),
            headers={"Content-Type": "text/xml", **basic_auth(raw)},
        )

        assert response.status_code == 200
        assert "SALES" in response.text
        assert not conn.closed


class TestThrottleForgiveness:
    def test_one_bad_token_retried_forever_counts_once(self):
        window = SlidingWindow(limit=3, window=60.0)
        for _ in range(20):
            window.register_failure_once("token:1.2.3.4", "digest-a")
        assert window.allowed("token:1.2.3.4")

    def test_distinct_bad_tokens_still_exhaust_the_budget(self):
        window = SlidingWindow(limit=3, window=60.0)
        for i in range(3):
            window.register_failure_once("token:1.2.3.4", f"digest-{i}")
        assert not window.allowed("token:1.2.3.4")

    def test_msolap_retry_burst_does_not_lock_out_a_fresh_token(
        self, client, db
    ):
        sess = create_session(db, account="ACME", user="ALICE", mode="dev")
        raw, _ = connect_token.mint(db, sess)
        db.commit()
        get_cache().put(sess.id, ScriptedConnection())

        for _ in range(12):  # well past the throttle limit of 8
            rejected = client.post(
                "/xmla", content=discover_body("MDSCHEMA_CUBES"),
                headers={"Content-Type": "text/xml",
                         **basic_auth("xlt_expired-token")},
            )
            assert rejected.status_code == 401

        accepted = client.post(
            "/xmla", content=discover_body("MDSCHEMA_CUBES"),
            headers={"Content-Type": "text/xml", **basic_auth(raw)},
        )
        assert accepted.status_code == 200
        assert "SALES" in accepted.text


class TestKeepAlive:
    def test_every_connect_path_opts_into_keep_alive(self, monkeypatch):
        calls = []
        monkeypatch.setattr(
            snowflake.connector, "connect",
            lambda **kw: calls.append(kw) or FakeConnection(),
        )
        sf_connect.connect_oauth("tok")
        sf_connect.connect_dev(
            account="acct", user="alice", authenticator="password", password="pw"
        )
        sf_connect.connect_dev(
            account="acct", user="alice", authenticator="externalbrowser"
        )
        assert all(kw.get("client_session_keep_alive") is True for kw in calls)


class TestIsolation:
    def test_the_throttle_window_is_reset_between_clients(self, make_client):
        # Guards the conftest reset: without it, one test's failures
        # bleed 429s into every later test in the run.
        make_client(SEMANTICUI_AUTH_MODE="dev")
        assert auth_window().allowed("token:testclient")
