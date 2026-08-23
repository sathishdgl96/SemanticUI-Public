"""Reading and writing deployment-wide notices.

Two audiences, one table. Everybody reads what is showing right now;
only an administrator named in the environment writes anything, and only
they see the ones that are switched off or not due yet.

The split matters more than it looks: "what is live" is answered by the
database, from a WHERE clause, rather than by fetching everything and
filtering in the caller -- so a deployment with a long history of
notices costs the same to read as one with none.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db.models import Announcement, User
from app.errors import ApiError

#: How loudly a notice is allowed to speak. Bounded so a level reaching a
#: class name cannot be anything a caller invents.
LEVELS = ("info", "warning", "critical")
MAX_MESSAGE = 500


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _row(row: Announcement, author: str = "") -> dict:
    return {
        "id": str(row.id),
        "message": row.message,
        "level": row.level,
        "active": row.active,
        "startsAt": row.starts_at.isoformat() if row.starts_at else None,
        "endsAt": row.ends_at.isoformat() if row.ends_at else None,
        "createdBy": author,
        "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
    }


def _authors(db: Session, ids) -> dict:
    keys = {key for key in ids if key is not None}
    if not keys:
        return {}
    rows = db.execute(
        select(User.id, User.snowflake_user).where(User.id.in_(keys))
    ).all()
    return {user_id: name for user_id, name in rows}


def live(db: Session) -> list[dict]:
    """What is showing right now, most urgent first.

    Filtered in SQL. A notice is live when it is switched on, has started,
    and has either no end or an end still ahead -- which is three columns
    and a WHERE, not a list to walk.
    """
    now = _now()
    rows = list(
        db.scalars(
            select(Announcement)
            .where(
                Announcement.active.is_(True),
                Announcement.starts_at <= now,
                or_(Announcement.ends_at.is_(None), Announcement.ends_at > now),
            )
            .order_by(Announcement.starts_at.desc())
            # A banner is not a feed. More than a few and nobody reads any
            # of them, so the page shows the newest handful.
            .limit(5)
        )
    )
    authors = _authors(db, [row.created_by for row in rows])
    # Loudest first: a critical notice under two informational ones is a
    # critical notice somebody scrolled past.
    order = {level: index for index, level in enumerate(reversed(LEVELS))}
    rows.sort(key=lambda row: order.get(row.level, len(LEVELS)))
    return [_row(row, authors.get(row.created_by, "")) for row in rows]


def listing(db: Session) -> list[dict]:
    """Every notice, for the administrator managing them.

    Including the ones switched off and the ones not due yet -- which is
    the whole reason this is a different function from `live` rather than
    a flag on it.
    """
    rows = list(
        db.scalars(select(Announcement).order_by(Announcement.starts_at.desc()).limit(200))
    )
    authors = _authors(db, [row.created_by for row in rows])
    return [_row(row, authors.get(row.created_by, "")) for row in rows]


def _clean(message: str, level: str) -> tuple[str, str]:
    text = (message or "").strip()
    if not text:
        raise ApiError("ANNOUNCEMENT_INVALID", 400, "An announcement needs something to say.")
    if len(text) > MAX_MESSAGE:
        raise ApiError(
            "ANNOUNCEMENT_INVALID",
            400,
            f"An announcement is at most {MAX_MESSAGE} characters.",
        )
    if level not in LEVELS:
        raise ApiError(
            "ANNOUNCEMENT_INVALID", 400, f"Level must be one of {', '.join(LEVELS)}."
        )
    return text, level


def create(
    db: Session,
    user_id: uuid.UUID,
    message: str,
    level: str = "info",
    starts_at: datetime | None = None,
    ends_at: datetime | None = None,
) -> dict:
    text, level = _clean(message, level)
    row = Announcement(
        message=text,
        level=level,
        active=True,
        starts_at=starts_at or _now(),
        ends_at=ends_at,
        created_by=user_id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _row(row, _authors(db, [user_id]).get(user_id, ""))


def update(
    db: Session,
    announcement_id: str,
    *,
    message: str | None = None,
    level: str | None = None,
    active: bool | None = None,
    ends_at: datetime | None = None,
    clear_end: bool = False,
) -> dict:
    row = _get(db, announcement_id)
    if message is not None or level is not None:
        row.message, row.level = _clean(
            message if message is not None else row.message,
            level if level is not None else row.level,
        )
    if active is not None:
        row.active = active
    if clear_end:
        row.ends_at = None
    elif ends_at is not None:
        row.ends_at = ends_at
    db.commit()
    db.refresh(row)
    return _row(row, _authors(db, [row.created_by]).get(row.created_by, ""))


def delete(db: Session, announcement_id: str) -> None:
    db.delete(_get(db, announcement_id))
    db.commit()


def _get(db: Session, announcement_id: str) -> Announcement:
    try:
        key = uuid.UUID(str(announcement_id))
    except (ValueError, TypeError, AttributeError) as error:
        raise ApiError("HTTP_ERROR", 404, "Not found") from error
    row = db.get(Announcement, key)
    if row is None:
        raise ApiError("HTTP_ERROR", 404, "Not found")
    return row
