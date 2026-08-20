"""The home page's endpoints.

Everything here is scoped to the calling session's user. There is no
`user_id` parameter anywhere, because there is no reading of anyone
else's home -- which is the simplest way to guarantee it.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.db.base import get_db
from app.db.models import DbSession
from app.home import service

router = APIRouter()


class PinBody(BaseModel):
    reportId: str
    pageId: str
    visualId: str
    #: Bounded because it reaches a page as text. The renderer escapes it,
    #: but a 10,000-character title is a layout bug either way.
    title: str | None = Field(default=None, max_length=200)


class LayoutEntry(BaseModel):
    id: str
    x: int = Field(ge=0, le=1000)
    y: int = Field(ge=0, le=10000)
    w: int = Field(ge=1, le=12)
    h: int = Field(ge=1, le=50)


class LayoutBody(BaseModel):
    #: Capped so one request cannot ask the server to walk an unbounded
    #: list. Nobody pins two hundred tiles; a caller claiming to have is
    #: not a caller to accommodate.
    layouts: list[LayoutEntry] = Field(default_factory=list, max_length=200)


@router.get("/api/home")
def get_home(
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Both halves in one request: the page has nothing to show without
    each of them, and two round trips would only stagger the arrival."""
    return {
        "recent": service.recent_items(db, sess.user_id),
        "widgets": service.list_widgets(db, sess.user_id),
    }


@router.post("/api/home/widgets", status_code=201)
def pin_visual(
    body: PinBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    return service.pin(
        db, sess.user_id, body.reportId, body.pageId, body.visualId, body.title
    )


@router.delete("/api/home/widgets/{widget_id}", status_code=204)
def unpin_visual(
    widget_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> None:
    service.unpin(db, sess.user_id, widget_id)


@router.patch("/api/home/widgets")
def rearrange_widgets(
    body: LayoutBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    service.rearrange(db, sess.user_id, [entry.model_dump() for entry in body.layouts])
    return {"ok": True}
