import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.crypto import encrypt_token
from app.config import get_settings
from app.db.models import DbSession, User

SESSION_COOKIE = "semanticui_session"


def new_session_id() -> str:
    return secrets.token_urlsafe(32)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(dt: datetime) -> datetime:
    # SQLite loses tzinfo; treat naive values as UTC.
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


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
        db.commit()
        return None
    sess.last_seen_at = _utcnow()
    db.commit()
    db.refresh(sess)
    return sess


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
