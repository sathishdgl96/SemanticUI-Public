"""Who is asking, and which app session their requests ride on.

The XMLA adapter and the feed never open Snowflake connections of their own.
The password field of HTTP Basic (or MSOLAP's Password property) carries a
CONNECT TOKEN minted by the signed-in app UI, and everything resolves through
it: the token names an app session, the session names the user, and the
session's cached Snowflake connection -- the same one the rest of the API
uses -- runs the queries. One auth path, one connection per user, and
revocation is the session's own logout/TTL.

Sessions: MSOLAP sends BeginSession once and then a Session header per call.
The store maps that XMLA session id to the app session id; it holds no
connection itself. A token digest index lets the handful of pre-session
Discovers land on one XMLA session instead of creating one each.
"""

import hashlib
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from app.auth import connect_token
from app.auth.sessions import get_active_session
from app.db.models import DbSession
from app.errors import ApiError
from app.semantic.discovery import list_semantic_views
from app.snowflake.provider import get_cache

#: An idle XMLA session mapping is dropped after this. It holds no
#: connection, so this is bookkeeping hygiene, not resource reclaim.
IDLE_TTL_SECONDS = 900
MAX_SESSIONS = 200


@dataclass
class XmlaSession:
    """One XMLA conversation, bound to an app session.

    `bind` attaches the app session's live cache entry for the duration of a
    request; `conn`, `describe` and `list_views` are only meaningful while
    the caller holds `entry.lock` -- the same contract the main API follows.
    """

    db_session_id: str
    user_id: Any
    last_seen: float = field(default_factory=time.monotonic)
    entry: Any = None
    views: list | None = None

    def touch(self) -> None:
        self.last_seen = time.monotonic()

    def bind(self, entry: Any) -> None:
        self.entry = entry

    @property
    def conn(self) -> Any:
        return self.entry.conn

    def list_views(self) -> list:
        if self.views is None:
            self.views = list_semantic_views(self.conn)
        return self.views

    def describe(self, database: str, schema: str, view: str) -> dict:
        return get_cache().describe(self.entry, database, schema, view)


class SessionStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_id: dict[str, XmlaSession] = {}
        self._by_digest: dict[str, str] = {}

    @staticmethod
    def _digest(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def open(self, db: Session, token: str) -> tuple[str, XmlaSession]:
        """The XMLA session for this connect token, creating one if needed."""
        digest = self._digest(token)
        with self._lock:
            self._sweep()
            existing = self._by_digest.get(digest)
            if existing and existing in self._by_id:
                session = self._by_id[existing]
                session.touch()
                return existing, session
        dbsess = connect_token.resolve(db, token)
        if dbsess is None:
            raise ApiError(
                "AUTH_FAILED",
                401,
                "Invalid or expired connect token. Create a new one from the "
                "report's Connect panel.",
            )
        session = XmlaSession(db_session_id=dbsess.id, user_id=dbsess.user_id)
        session_id = secrets.token_hex(16)
        with self._lock:
            self._by_id[session_id] = session
            self._by_digest[digest] = session_id
        return session_id, session

    def get(self, session_id: str) -> XmlaSession | None:
        with self._lock:
            session = self._by_id.get(session_id)
            if session:
                session.touch()
            return session

    def end(self, session_id: str) -> None:
        with self._lock:
            self._by_id.pop(session_id, None)
            self._by_digest = {
                d: s for d, s in self._by_digest.items() if s != session_id
            }

    def _sweep(self) -> None:
        now = time.monotonic()
        dead = [
            sid
            for sid, s in self._by_id.items()
            if now - s.last_seen > IDLE_TTL_SECONDS
        ]
        overflow = len(self._by_id) - len(dead) - MAX_SESSIONS
        if overflow > 0:
            by_age = sorted(
                (s.last_seen, sid)
                for sid, s in self._by_id.items()
                if sid not in dead
            )
            dead += [sid for _, sid in by_age[:overflow]]
        for sid in dead:
            self._by_id.pop(sid, None)
        self._by_digest = {
            d: s for d, s in self._by_digest.items() if s in self._by_id
        }


def acquire_entry(db: Session, session: XmlaSession) -> Any:
    """The live cache entry for this XMLA session's app session.

    Raises 401 if the app session died since the token was presented --
    logging out of the app disconnects Excel, which is exactly the point.
    """
    dbsess = get_active_session(db, session.db_session_id)
    if dbsess is None:
        raise ApiError(
            "AUTH_FAILED", 401, "The app session behind this token has ended; "
            "sign in and create a new connect token."
        )
    return get_cache().acquire(db, dbsess)


_store: SessionStore | None = None


def get_store() -> SessionStore:
    global _store
    if _store is None:
        _store = SessionStore()
    return _store
