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
from app.snowflake import connect as sf_connect

_REFRESH_SKEW = timedelta(seconds=30)


@dataclass
class CacheEntry:
    conn: Any
    last_used: float
    lock: threading.Lock = field(default_factory=threading.Lock)


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
        clock: Callable[[], float] = time.monotonic,
    ):
        self._idle_ttl = idle_ttl
        self._max_size = max_size
        self._clock = clock
        self._entries: dict[str, CacheEntry] = {}
        self._lock = threading.Lock()

    def put(self, session_id: str, conn: Any) -> None:
        with self._lock:
            old = self._entries.pop(session_id, None)
            if old is not None:
                _close_quietly(old.conn)
            self._entries[session_id] = CacheEntry(conn=conn, last_used=self._clock())
            self._enforce_cap()

    def _enforce_cap(self) -> None:
        while len(self._entries) > self._max_size:
            oldest_id = min(self._entries, key=lambda k: self._entries[k].last_used)
            _close_quietly(self._entries.pop(oldest_id).conn)

    def acquire(self, db: Session, sess: DbSession) -> CacheEntry:
        with self._lock:
            entry = self._entries.get(sess.id)
            if entry is not None and _is_alive(entry.conn):
                entry.last_used = self._clock()
                return entry
            if entry is not None:
                _close_quietly(self._entries.pop(sess.id).conn)
        if sess.mode != "oauth":
            raise AuthExpiredError("Dev session connection lost; sign in again")
        conn = self._build_oauth(db, sess)
        with self._lock:
            self._entries[sess.id] = CacheEntry(conn=conn, last_used=self._clock())
            self._enforce_cap()
            return self._entries[sess.id]

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

    def sweep(self) -> int:
        cutoff = self._clock() - self._idle_ttl
        closed = 0
        with self._lock:
            for sid in [s for s, e in self._entries.items() if e.last_used < cutoff]:
                _close_quietly(self._entries.pop(sid).conn)
                closed += 1
        return closed


_cache: ConnectionCache | None = None


def get_cache() -> ConnectionCache:
    global _cache
    if _cache is None:
        settings = get_settings()
        _cache = ConnectionCache(
            idle_ttl=settings.connection_idle_ttl_seconds,
            max_size=settings.connection_cache_max,
        )
    return _cache


def reset_cache() -> None:
    global _cache
    if _cache is not None:
        for sid in list(_cache._entries):
            _cache.evict(sid)
    _cache = None
