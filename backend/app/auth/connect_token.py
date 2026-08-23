"""The connect token: how Excel borrows an app session without a password.

Excel's clients (Power Query's Basic auth, MSOLAP's User ID/Password) can
only carry a name and a secret. Instead of teaching them Snowflake
credentials -- which would mean the adapters opening their own Snowflake
connections, a second auth path to keep correct forever -- the app UI mints
a short-lived bearer from the session the user already holds. Presenting it
resolves to THAT session: same user, same workspace rights, same cached
Snowflake connection, same expiry sweep.

Only the sha256 of the token is stored. One token per session; minting again
replaces the old one, logging out (session deletion) revokes it, and the
session's own TTL bounds it from above -- get_active_session is the second
gate below, so a token can never outlive its session.
"""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.sessions import get_active_session
from app.config import get_settings
from app.db.models import DbSession

#: The prefix makes a leaked value recognisable in logs and lets the
#: resolver refuse non-tokens without a table scan.
_PREFIX = "xlt_"


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def mint(db: Session, sess: DbSession) -> tuple[str, datetime]:
    """A fresh token for this session; the raw value is returned exactly once."""
    raw = _PREFIX + secrets.token_urlsafe(24)
    expires = _utcnow() + timedelta(hours=get_settings().connect_token_ttl_hours)
    sess.connect_token_hash = _hash(raw)
    sess.connect_token_expires_at = expires
    db.commit()
    return raw, expires


def resolve(db: Session, raw: str) -> DbSession | None:
    """The live session this token belongs to, or None.

    None covers every failure alike -- wrong shape, unknown, expired token,
    expired session -- so the caller's 401 does not say which.
    """
    if not raw or not raw.startswith(_PREFIX):
        return None
    sess = db.scalar(
        select(DbSession).where(DbSession.connect_token_hash == _hash(raw))
    )
    if sess is None:
        return None
    expires = sess.connect_token_expires_at
    if expires is None:
        return None
    if expires.tzinfo is None:  # SQLite loses tzinfo; stored values are UTC
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= _utcnow():
        return None
    # The session itself must still be alive; this also touches last_seen,
    # so an actively refreshing workbook keeps its session warm.
    return get_active_session(db, sess.id)
