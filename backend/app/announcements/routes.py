"""Announcement endpoints.

Reading what is live needs a session and nothing more -- it is shown to
everybody. Writing anything needs the admin gate, which reads its list
from the environment: a notice shown to every user is not a permission
any row in this database should be able to grant.
"""

from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.admin.routes import require_app_admin
from app.announcements import service
from app.audit import record
from app.auth.routes import current_session
from app.db.base import get_db
from app.db.models import DbSession

router = APIRouter()


class CreateBody(BaseModel):
    message: str = Field(max_length=service.MAX_MESSAGE)
    level: str = "info"
    startsAt: datetime | None = None
    endsAt: datetime | None = None


class UpdateBody(BaseModel):
    message: str | None = Field(default=None, max_length=service.MAX_MESSAGE)
    level: str | None = None
    active: bool | None = None
    endsAt: datetime | None = None
    #: Distinct from endsAt being absent: absent means "leave it", this
    #: means "make it open-ended".
    clearEnd: bool = False


@router.get("/api/announcements")
def live(
    _: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    """What is showing right now. Everybody sees this."""
    return {"announcements": service.live(db)}


@router.get("/api/admin/announcements")
def listing(
    _: DbSession = Depends(require_app_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Every notice, including the ones switched off and the ones not due
    yet -- which only the person managing them has any use for."""
    return {"announcements": service.listing(db)}


@router.post("/api/admin/announcements", status_code=201)
def create(
    body: CreateBody,
    sess: DbSession = Depends(require_app_admin),
    db: Session = Depends(get_db),
) -> dict:
    made = service.create(
        db, sess.user_id, body.message, body.level, body.startsAt, body.endsAt
    )
    # Audited like every other administrative act. The message itself is
    # not recorded: the trail holds shapes, and this one is readable by
    # anybody with the admin area anyway.
    record(
        db,
        "announcement.create",
        user_id=sess.user_id,
        session_id=sess.id,
        resource_type="announcement",
        resource_id=made["id"],
        detail={"level": made["level"]},
    )
    return made


@router.patch("/api/admin/announcements/{announcement_id}")
def update(
    announcement_id: str,
    body: UpdateBody,
    sess: DbSession = Depends(require_app_admin),
    db: Session = Depends(get_db),
) -> dict:
    changed = service.update(
        db,
        announcement_id,
        message=body.message,
        level=body.level,
        active=body.active,
        ends_at=body.endsAt,
        clear_end=body.clearEnd,
    )
    record(
        db,
        "announcement.update",
        user_id=sess.user_id,
        session_id=sess.id,
        resource_type="announcement",
        resource_id=announcement_id,
        detail={"active": changed["active"]},
    )
    return changed


@router.delete("/api/admin/announcements/{announcement_id}", status_code=204)
def delete(
    announcement_id: str,
    sess: DbSession = Depends(require_app_admin),
    db: Session = Depends(get_db),
) -> None:
    service.delete(db, announcement_id)
    record(
        db,
        "announcement.delete",
        user_id=sess.user_id,
        session_id=sess.id,
        resource_type="announcement",
        resource_id=announcement_id,
    )
