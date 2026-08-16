import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Response
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from app.auth.crypto import encrypt_token
from app.config import get_settings
from app.db.models import DbSession, User

logger = logging.getLogger(__name__)
SESSION_COOKIE = "semanticui_session"


def new_session_id() -> str:
    return secrets.token_urlsafe(32)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(dt: datetime) -> datetime:
    # SQLite loses tzinfo; treat naive values as UTC.
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _commit_or_stale(db: Session, session_id: str) -> bool:
    """Commit changes or handle stale data error.

    Returns True on successful commit, False if the row was deleted
    concurrently (StaleDataError). Rolls back and logs on stale data.
    """
    try:
        db.commit()
        return True
    except StaleDataError:
        logger.warning("session %s vanished during touch; treating as inactive", session_id)
        db.rollback()
        return False


def create_session(
    db: Session,
    *,
    account: str,
    user: str,
    mode: str,
    access_token: str | None = None,
    refresh_token: str | None = None,
    access_expires_at: datetime | None = None,
) -> DbSession:
    existing = db.scalar(
        select(User).where(
            User.snowflake_account == account, User.snowflake_user == user
        )
    )
    if existing is None:
        existing = User(snowflake_account=account, snowflake_user=user)
        db.add(existing)
        db.flush()
    # Every user has exactly one personal workspace, so "which workspace does
    # this report belong to" always has an answer and there is no second,
    # unfiled access path. Imported here rather than at module scope:
    # app.workspaces.service is not importable while this module is being
    # loaded during app construction.
    from app.workspaces.service import ensure_personal_workspace

    ensure_personal_workspace(db, existing)
    sess = DbSession(
        id=new_session_id(),
        user_id=existing.id,
        mode=mode,
        access_token_enc=encrypt_token(access_token) if access_token else None,
        refresh_token_enc=encrypt_token(refresh_token) if refresh_token else None,
        access_expires_at=access_expires_at,
    )
    db.add(sess)
    db.commit()
    db.refresh(sess)
    return sess


def get_active_session(db: Session, session_id: str) -> DbSession | None:
    sess = db.get(DbSession, session_id)
    if sess is None:
        return None
    ttl = timedelta(hours=get_settings().session_ttl_hours)
    if _utcnow() - _as_utc(sess.last_seen_at) > ttl:
        db.delete(sess)
        if not _commit_or_stale(db, session_id):
            return None
        return None
    sess.last_seen_at = _utcnow()
    if not _commit_or_stale(db, session_id):
        return None
    db.refresh(sess)
    return sess


def purge_expired_sessions(db: Session) -> int:
    """Delete every session row whose last_seen_at is past the TTL.

    Unlike get_active_session (which only reaps a row when someone
    presents that exact cookie again), this is meant to be called
    periodically by a background sweeper so an abandoned OAuth session
    doesn't keep its Fernet-encrypted refresh token in Postgres
    indefinitely and the table doesn't grow without bound.

    Filters in Python (via _as_utc) rather than at the SQL level: SQLite
    loses tzinfo on stored datetimes (see _as_utc), so a naive DB-side
    comparison against an aware cutoff is not reliable across both the
    SQLite test backend and Postgres.
    """
    ttl = timedelta(hours=get_settings().session_ttl_hours)
    cutoff = _utcnow() - ttl
    stale = [
        sess
        for sess in db.scalars(select(DbSession)).all()
        if _as_utc(sess.last_seen_at) < cutoff
    ]
    for sess in stale:
        db.delete(sess)
    if stale:
        db.commit()
    return len(stale)


def delete_session(db: Session, session_id: str) -> None:
    sess = db.get(DbSession, session_id)
    if sess is not None:
        db.delete(sess)
        db.commit()


def set_session_cookie(response: Response, session_id: str) -> None:
    settings = get_settings()
    response.set_cookie(
        SESSION_COOKIE,
        session_id,
        httponly=True,
        secure=settings.auth_mode != "dev",
        samesite="lax",
        max_age=settings.session_ttl_hours * 3600,
    )
