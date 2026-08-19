import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, JSON, LargeBinary, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("snowflake_account", "snowflake_user", name="uq_users_identity"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    snowflake_account: Mapped[str] = mapped_column(String(255))
    snowflake_user: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class DbSession(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    mode: Mapped[str] = mapped_column(String(8))
    access_token_enc: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    refresh_token_enc: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    access_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    #: The Excel/Power Query bearer: sha256 hex of a token the UI showed
    #: exactly once. Only the hash is stored; presenting the raw token is the
    #: only way in, and it rides on THIS session -- its connection, its user,
    #: its lifetime. NULL means no token has been minted (or it was revoked).
    connect_token_hash: Mapped[str | None] = mapped_column(
        String(64), nullable=True, index=True
    )
    connect_token_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    user: Mapped[User] = relationship()


class Workspace(Base):
    __tablename__ = "workspaces"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200))
    #: "personal" or "shared". A personal workspace refuses members, renames
    #: and deletion -- that is what distinguishes "my private drafts" from a
    #: shared workspace that happens to have one member today.
    kind: Mapped[str] = mapped_column(String(16), default="shared")
    #: Membership is confined to this Snowflake account: a user from another
    #: account could never resolve the views these reports bind to, so the
    #: grant would be an illusion of access.
    snowflake_account: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class WorkspaceMember(Base):
    __tablename__ = "workspace_members"
    __table_args__ = (
        UniqueConstraint("workspace_id", "user_id", name="uq_workspace_members"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    #: Indexed because "which workspaces am I in" runs on every report list.
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    role: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class Report(Base):
    __tablename__ = "reports"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    #: Provenance only -- who created this. It is NOT the access check; see
    #: workspace_id below and app/workspaces/access.py.
    owner_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id"), index=True
    )
    #: The access boundary. Everything about who may read or edit this report
    #: is decided by membership of this workspace.
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    view_database: Mapped[str] = mapped_column(String(255))
    view_schema: Mapped[str] = mapped_column(String(255))
    view_name: Mapped[str] = mapped_column(String(255))
    #: The portable definition document. JSONB on Postgres, JSON on SQLite.
    definition: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, onupdate=now_utc
    )


class AuditEvent(Base):
    """One security-relevant act. Value-free by contract: names of the
    acting user and the touched resource are IDs, `detail` holds only
    shapes (counts, flags), never data values or resource names."""

    __tablename__ = "audit_events"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    ts: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, index=True
    )
    request_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    #: sha256 prefix of the session id -- correlates events of one session
    #: without the audit table becoming a cookie-theft target.
    session_ref: Mapped[str | None] = mapped_column(String(16), nullable=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    resource_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    resource_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    outcome: Mapped[str] = mapped_column(String(16), default="ok")
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class SavedExplore(Base):
    """A saved query, not a saved canvas.

    Looker's Look, in this codebase's vocabulary: one semantic view, a set of
    fields, its filters and its ordering. Deliberately its own table rather
    than a Report with a single table visual -- an explore has no layout, no
    pages and no visuals, and modelling it as a degenerate report would mean
    every report code path had to keep asking whether it was really an
    explore.
    """

    __tablename__ = "saved_explores"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    #: Provenance only -- who created this. It is NOT the access check; see
    #: workspace_id below and app/workspaces/access.py.
    owner_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id"), index=True
    )
    #: The access boundary, exactly as for a report.
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    view_database: Mapped[str] = mapped_column(String(255))
    view_schema: Mapped[str] = mapped_column(String(255))
    view_name: Mapped[str] = mapped_column(String(255))
    #: The explore document: fields, filters, ordering, row cap.
    definition: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, onupdate=now_utc
    )
