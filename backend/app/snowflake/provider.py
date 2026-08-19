"""The per-app-session Snowflake connection cache.

One connection per session, guarded by a per-entry lock. OAuth entries
rebuild silently from the stored refresh token; dev/key-pair entries
ARE the only copy of the credential, so they are retained for the
session lifetime and losing one means signing in again. discard() is
the self-healing path for connections that died server-side while
still reporting open.
"""

import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy.orm import Session

from app.auth import oauth as oauth_mod
from app.auth.crypto import decrypt_token, encrypt_token
from app.auth.oauth import OAuthRefreshError
from app.config import get_settings
from app.db.models import DbSession
from app.errors import AuthExpiredError
from app.semantic.discovery import describe_semantic_view
from app.snowflake import connect as sf_connect

_REFRESH_SKEW = timedelta(seconds=30)


@dataclass
class CacheEntry:
    conn: Any
    last_used: float
    lock: threading.Lock = field(default_factory=threading.Lock)
    #: An OAuth connection can be rebuilt silently from its stored refresh
    #: token, so reclaiming it when idle is invisible to the user. A dev or
    #: key-pair connection IS the only copy of the credential — reclaiming it
    #: forces a fresh SSO round trip or a re-pasted private key, so it is held
    #: for the life of the session instead. See ConnectionCache.sweep.
    rebuildable: bool = True
    #: Per-view DESCRIBE results for THIS session only, keyed "DB.SCHEMA.VIEW"
    #: -> (stored_at, detail). Lives inside the entry so one user's catalog can
    #: never be served to another; dies when the entry is evicted.
    describe_cache: dict[str, tuple[float, dict]] = field(default_factory=dict)


def _is_alive(conn: Any) -> bool:
    try:
        return not conn.is_closed()
    except Exception:
        return False


def _close_quietly(conn: Any) -> None:
    try:
        conn.close()
    except Exception:
        pass


class ConnectionCache:
    def __init__(
        self,
        *,
        idle_ttl: float,
        max_size: int,
        retain_ttl: float | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._idle_ttl = idle_ttl
        #: Idle budget for connections that cannot be rebuilt without the user
        #: signing in again. Defaults to the plain idle TTL so existing callers
        #: keep their behaviour; production passes the session lifetime.
        self._retain_ttl = idle_ttl if retain_ttl is None else retain_ttl
        self._max_size = max_size
        self._clock = clock
        self._entries: dict[str, CacheEntry] = {}
        self._lock = threading.Lock()

    def put(self, session_id: str, conn: Any, *, rebuildable: bool = True) -> None:
        to_close: list[Any] = []
        with self._lock:
            old = self._entries.pop(session_id, None)
            if old is not None:
                to_close.append(old.conn)
            self._entries[session_id] = CacheEntry(
                conn=conn, last_used=self._clock(), rebuildable=rebuildable
            )
            to_close.extend(self._enforce_cap_locked())
        for c in to_close:
            _close_quietly(c)

    def _enforce_cap_locked(self) -> list[Any]:
        """Evict the oldest non-busy entries until the cache is at/under cap.

        Must be called with self._lock held. `last_used` is stamped at
        acquire time, so a session running a long query looks
        progressively older; evicting purely by age can close a live
        cursor's connection out from under an in-flight query. Use the
        same non-blocking `entry.lock` guard `sweep` uses: skip entries
        that are currently busy and evict the next-oldest free one
        instead. If every over-cap candidate is busy, leave the cache
        over cap rather than killing a live query.

        Returns the evicted connections so the caller can close them
        after releasing self._lock (driver `close()` can block on
        network I/O and would otherwise serialize all cache operations).
        """
        to_close: list[Any] = []
        while len(self._entries) > self._max_size:
            ordered = sorted(self._entries.items(), key=lambda kv: kv[1].last_used)
            evicted = False
            for sid, entry in ordered:
                if not entry.lock.acquire(blocking=False):
                    continue
                try:
                    popped = self._entries.pop(sid, None)
                finally:
                    entry.lock.release()
                if popped is not None:
                    to_close.append(popped.conn)
                    evicted = True
                break
            if not evicted:
                break
        return to_close

    def acquire(self, db: Session, sess: DbSession) -> CacheEntry:
        to_close: list[Any] = []
        with self._lock:
            entry = self._entries.get(sess.id)
            if entry is not None and _is_alive(entry.conn):
                entry.last_used = self._clock()
                return entry
            if entry is not None:
                to_close.append(self._entries.pop(sess.id).conn)
        for c in to_close:
            _close_quietly(c)
        if sess.mode != "oauth":
            raise AuthExpiredError("Dev session connection lost; sign in again")
        conn = self._build_oauth(db, sess)
        to_close = []
        with self._lock:
            existing = self._entries.get(sess.id)
            if existing is not None and _is_alive(existing.conn):
                to_close.append(conn)
                existing.last_used = self._clock()
                result = existing
            else:
                if existing is not None:
                    to_close.append(self._entries.pop(sess.id).conn)
                # Only OAuth reaches this rebuild path, so the entry is
                # rebuildable by construction.
                self._entries[sess.id] = CacheEntry(
                    conn=conn, last_used=self._clock(), rebuildable=True
                )
                to_close.extend(self._enforce_cap_locked())
                result = self._entries[sess.id]
        for c in to_close:
            _close_quietly(c)
        return result

    def _build_oauth(self, db: Session, sess: DbSession) -> Any:
        token = decrypt_token(sess.access_token_enc)
        expires_at = sess.access_expires_at
        if expires_at is not None and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        if expires_at is None or expires_at <= now + _REFRESH_SKEW:
            if sess.refresh_token_enc is None:
                raise AuthExpiredError()
            try:
                tok = oauth_mod.get_oauth_client().refresh(
                    decrypt_token(sess.refresh_token_enc)
                )
            except OAuthRefreshError as exc:
                raise AuthExpiredError() from exc
            token = tok.access_token
            sess.access_token_enc = encrypt_token(tok.access_token)
            if tok.refresh_token:
                sess.refresh_token_enc = encrypt_token(tok.refresh_token)
            sess.access_expires_at = now + timedelta(seconds=tok.expires_in)
            db.commit()
        return sf_connect.connect_oauth(token)

    def evict(self, session_id: str) -> None:
        with self._lock:
            entry = self._entries.pop(session_id, None)
        if entry is not None:
            _close_quietly(entry.conn)

    def discard(self, session_id: str, entry: CacheEntry) -> None:
        """Drop THIS entry because its connection proved dead mid-query.

        `is_closed()` is a client-side flag; a connection killed server-side
        (idle timeout, network change) still reports open, so `acquire`
        keeps returning it and every request fails identically. When a query
        raises a session-gone error, the caller hands the entry back here;
        the next acquire then rebuilds (OAuth) or asks for a sign-in (dev)
        instead of failing forever. The identity check keeps a slow caller
        from evicting a successor a concurrent request already rebuilt.
        """
        with self._lock:
            if self._entries.get(session_id) is not entry:
                return
            self._entries.pop(session_id, None)
        _close_quietly(entry.conn)

    @staticmethod
    def _describe_key(database: str, schema: str, name: str) -> str:
        return f"{database}.{schema}.{name}"

    def describe(
        self,
        entry: CacheEntry,
        database: str,
        schema: str,
        name: str,
        *,
        force: bool = False,
    ) -> dict:
        """Return the semantic view's description, cached per session.

        A report issues one query per visual and each validates its field
        references against a DESCRIBE; without this every refresh would run N
        identical describes. The caller must hold `entry.lock`, as it already
        does for the query it is about to build.
        """
        key = self._describe_key(database, schema, name)
        ttl = get_settings().describe_cache_ttl_seconds
        now = self._clock()
        if not force:
            cached = entry.describe_cache.get(key)
            if cached is not None and (now - cached[0]) < ttl:
                return cached[1]
        detail = describe_semantic_view(entry.conn, database, schema, name)
        entry.describe_cache[key] = (now, detail)
        return detail

    def invalidate_describe(
        self, entry: CacheEntry, database: str, schema: str, name: str
    ) -> None:
        entry.describe_cache.pop(self._describe_key(database, schema, name), None)

    def sweep(self) -> int:
        """Reclaim idle connections.

        Rebuildable (OAuth) entries go at the idle TTL, since rebuilding them
        is transparent. Non-rebuildable (dev / key-pair) entries are the only
        copy of the user's credential, so evicting one silently logs them out
        mid-session; those are held until their session would have expired
        anyway.
        """
        now = self._clock()
        idle_cutoff = now - self._idle_ttl
        retain_cutoff = now - self._retain_ttl
        to_close: list[Any] = []
        with self._lock:
            candidates = [
                s
                for s, e in self._entries.items()
                if e.last_used < (idle_cutoff if e.rebuildable else retain_cutoff)
            ]
            for sid in candidates:
                entry = self._entries.get(sid)
                if entry is None:
                    continue
                if not entry.lock.acquire(blocking=False):
                    continue
                try:
                    popped = self._entries.pop(sid, None)
                    if popped is not None:
                        to_close.append(popped.conn)
                finally:
                    entry.lock.release()
        for c in to_close:
            _close_quietly(c)
        return len(to_close)


_cache: ConnectionCache | None = None


def get_cache() -> ConnectionCache:
    global _cache
    if _cache is None:
        settings = get_settings()
        _cache = ConnectionCache(
            idle_ttl=settings.connection_idle_ttl_seconds,
            max_size=settings.connection_cache_max,
            # A credential-bearing connection is held for the session's own
            # lifetime: reclaiming it earlier would log the user out mid-session
            # with no way to reconnect except a fresh SSO or PEM entry.
            retain_ttl=settings.session_ttl_hours * 3600,
        )
    return _cache


def reset_cache() -> None:
    global _cache
    if _cache is not None:
        for sid in list(_cache._entries):
            _cache.evict(sid)
    _cache = None
