r"""Who is asking, and the Snowflake connection their requests run on.

The product rule does not bend for a new protocol: every Discover and every
Execute runs on the CALLER'S own Snowflake connection. Excel's MSOLAP client
sends HTTP Basic, so Basic is mapped onto exactly the machinery password
dev-login already uses -- the credentials open a connection as that user, and
nothing is ever answered from anyone else's.

The username carries the account as well as the user, because Basic has only
two fields and Snowflake needs three:

    account\user       (also accepted: account/user)

Sessions: MSOLAP sends BeginSession once and then a Session header per call.
The store is keyed by that id, holds one connection + describe cache, and is
also reachable by a credentials digest so the handful of pre-session
Discovers land on the same connection instead of opening one each.
"""

import hashlib
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from app.errors import ApiError
from app.semantic.discovery import describe_semantic_view, list_semantic_views
from app.snowflake import connect as sf_connect

#: An idle XMLA session's connection is dropped after this. Excel refreshes
#: reuse the session id, so an active pivot never sees it.
IDLE_TTL_SECONDS = 900
MAX_SESSIONS = 50


@dataclass
class XmlaSession:
    conn: Any
    account: str
    user: str
    #: Who Snowflake says this connection is: (account LOCATOR, user), from
    #: probe_identity. The locator, not the org identifier the caller typed
    #: -- because that is what dev-login stored in the users table, and an
    #: account has both names. Matching the typed form against the stored
    #: locator is a 404 for every legitimate caller.
    probed_account: str = ""
    probed_user: str = ""
    lock: threading.Lock = field(default_factory=threading.Lock)
    last_seen: float = field(default_factory=time.monotonic)
    #: (db, schema, view) -> describe dict. Same idea as the main cache's
    #: describe TTL, scoped to this session.
    describes: dict = field(default_factory=dict)
    views: list | None = None

    def touch(self) -> None:
        self.last_seen = time.monotonic()

    def list_views(self) -> list:
        if self.views is None:
            self.views = list_semantic_views(self.conn)
        return self.views

    def describe(self, database: str, schema: str, view: str) -> dict:
        key = (database.upper(), schema.upper(), view.upper())
        if key not in self.describes:
            self.describes[key] = describe_semantic_view(
                self.conn, database, schema, view
            )
        return self.describes[key]


class SessionStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_id: dict[str, XmlaSession] = {}
        self._by_digest: dict[str, str] = {}

    @staticmethod
    def _digest(account: str, user: str, password: str) -> str:
        raw = f"{account}\x00{user}\x00{password}".encode("utf-8")
        return hashlib.sha256(raw).hexdigest()

    def open(self, username: str, password: str) -> tuple[str, XmlaSession]:
        """The session for these credentials, connecting if none exists."""
        account, user = split_username(username)
        digest = self._digest(account, user, password)
        with self._lock:
            self._sweep()
            existing = self._by_digest.get(digest)
            if existing and existing in self._by_id:
                session = self._by_id[existing]
                session.touch()
                return existing, session
        # Connect OUTSIDE the store lock: a Snowflake login is seconds, and
        # holding the lock through it would stall every other caller.
        conn = sf_connect.connect_dev(
            account=account, user=user, authenticator="password", password=password
        )
        probed_account, probed_user = sf_connect.probe_identity(conn)
        session = XmlaSession(
            conn=conn,
            account=account,
            user=user,
            probed_account=probed_account,
            probed_user=probed_user,
        )
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
            session = self._by_id.pop(session_id, None)
            self._by_digest = {
                d: s for d, s in self._by_digest.items() if s != session_id
            }
        if session:
            try:
                session.conn.close()
            except Exception:
                pass

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
            session = self._by_id.pop(sid, None)
            if session:
                try:
                    session.conn.close()
                except Exception:
                    pass
        self._by_digest = {
            d: s for d, s in self._by_digest.items() if s in self._by_id
        }


def split_username(username: str) -> tuple[str, str]:
    r"""account\user or account/user -> (account, user)."""
    for sep in ("\\", "/"):
        if sep in username:
            account, _, user = username.partition(sep)
            if account and user:
                return account, user
    raise ApiError(
        "AUTH_FAILED",
        401,
        "The XMLA username must carry both halves: your Snowflake account "
        "identifier and your username, joined by a slash or backslash -- "
        "e.g. myorg-myaccount/jsmith.",
    )


_store: SessionStore | None = None


def get_store() -> SessionStore:
    global _store
    if _store is None:
        _store = SessionStore()
    return _store
