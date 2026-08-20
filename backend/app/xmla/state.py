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
    #: Request-scoped, set by bind() and only valid under entry.lock.
    db: Any = None
    #: Synthetic describes for the composite models this caller can see,
    #: keyed by the (database, schema, name) triple they are listed under.
    #: Built once per conversation beside `views`, for the same reason.
    _model_details: dict | None = None
    _model_defs: dict | None = None

    def touch(self) -> None:
        self.last_seen = time.monotonic()

    def bind(self, entry: Any, db: Any = None) -> None:
        self.entry = entry
        self.db = db

    @property
    def conn(self) -> Any:
        return self.entry.conn

    def list_views(self) -> list:
        """Every cube this caller can see: Snowflake's semantic views, and
        the composite models they are a member of.

        Models come last so a client listing cubes sees the warehouse's
        own first, and so a failure to build them cannot cost the caller
        the views that were already working.
        """
        if self.views is None:
            self.views = list_semantic_views(self.conn) + self._composite_views()
        return self.views

    def _composite_views(self) -> list:
        """Composite models as cubes, with their synthetic describes.

        Errors are swallowed on purpose: a model with a member the caller
        cannot read, or a definition that no longer parses, must not take
        Excel's whole cube list down with it.
        """
        from app.xmla.composite_source import (
            member_describes,
            synthetic_detail,
            synthetic_view,
        )

        self._model_details = {}
        self._model_defs = {}
        if self.db is None:
            return []
        try:
            from app.composites.schema import parse_definition
            from app.db.models import CompositeModel, Workspace, WorkspaceMember

            rows = (
                self.db.query(CompositeModel)
                .join(
                    WorkspaceMember,
                    WorkspaceMember.workspace_id == CompositeModel.workspace_id,
                )
                .filter(WorkspaceMember.user_id == self.user_id)
                .all()
            )
        except Exception:
            return []

        out = []
        for row in rows:
            try:
                definition = parse_definition(row.definition or {})
                if not definition.members:
                    # Nothing to query yet; a cube with no fields is worse
                    # than no cube.
                    continue
                workspace = self.db.get(Workspace, row.workspace_id)
                view = synthetic_view(row, workspace.name if workspace else "Models")
                detail = synthetic_detail(
                    definition, member_describes(self, definition)
                )
                if not detail["dimensions"] and not detail["metrics"]:
                    continue
                key = (view["database"], view["schema"], view["name"])
                self._model_details[key] = detail
                self._model_defs[key] = definition
                out.append(view)
            except Exception:
                continue
        return out

    def model_definition(self, database: str, schema: str, view: str):
        """The parsed definition behind a composite cube, or None."""
        if self._model_defs is None:
            self.list_views()
        return (self._model_defs or {}).get((database, schema, view))

    def describe(self, database: str, schema: str, view: str) -> dict:
        """A cube's describe: synthetic for a model, Snowflake's otherwise.

        Checked before the cache because a model has no Snowflake object
        to describe -- asking would be an error, not a cache miss.
        """
        if self._model_details is None and database == "Models":
            self.list_views()
        synthetic = (self._model_details or {}).get((database, schema, view))
        if synthetic is not None:
            return synthetic
        return get_cache().describe(self.entry, database, schema, view)

    def user_hierarchies(self, view: dict) -> list[dict]:
        """Hierarchies this user defined on reports over this view.

        The report builder is where drill paths are authored; surfacing them
        over XMLA is what gives Excel true multi-level hierarchies -- one
        draggable field with a native drill and a multilevel filter tree.
        Only reports in workspaces the caller belongs to contribute, so the
        catalog can never leak a colleague's modelling.

        Returns [{"name", "home", "levels": [(table, field), ...]}, ...],
        deduplicated by name (first definition wins), levels validated
        against the live describe.
        """
        if self.db is None:
            return []
        from app.db.models import Report, WorkspaceMember

        detail = self.describe(view["database"], view["schema"], view["name"])
        known = {
            (d["table"].upper(), d["name"].upper()): (d["table"], d["name"])
            for d in detail.get("dimensions", [])
        }
        field_names = {name for _, name in known}
        rows = (
            self.db.query(Report)
            .join(WorkspaceMember, WorkspaceMember.workspace_id == Report.workspace_id)
            .filter(WorkspaceMember.user_id == self.user_id)
            .all()
        )
        out: list[dict] = []
        seen: set[str] = set()
        for report in rows:
            if (report.view_database or "").upper() != view["database"].upper():
                continue
            if (report.view_schema or "").upper() != view["schema"].upper():
                continue
            if (report.view_name or "").upper() != view["name"].upper():
                continue
            for h in (report.definition or {}).get("hierarchies", []):
                name = (h.get("name") or "").strip()
                if not name or name.upper() in seen:
                    continue
                levels = []
                for ref in h.get("levels", []):
                    table, _, field_name = str(ref).partition(".")
                    hit = known.get((table.upper(), field_name.upper()))
                    if hit is None:
                        levels = []
                        break
                    levels.append(hit)
                if len(levels) < 2:
                    continue  # one level is just the attribute hierarchy
                # A hierarchy named like a field of its home table would
                # collide with that attribute hierarchy's unique name.
                if name.upper() in field_names:
                    continue
                seen.add(name.upper())
                out.append({"name": name, "home": levels[0][0], "levels": levels})
        return out


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
        from app.audit import record

        record(db, "xmla.session_open", user_id=dbsess.user_id,
               session_id=dbsess.id)
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


def reset_store() -> None:
    """Test isolation: XMLA sessions must not leak between test apps."""
    global _store
    _store = None
