"""Pinning an item, and recording that it was opened.

Both go through the item's own authorization gate before touching any
state, so a stranger cannot pin -- or learn the existence of -- a report
they may not read. That is why these endpoints resolve the item rather
than trusting the id they were handed.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.db.base import get_db
from app.db.models import Dashboard, DbSession, Report, SavedExplore
from app.errors import ApiError
from app.library import state
from app.workspaces.access import require_owned

router = APIRouter()

#: The item kinds addressable here, mapped to the table each lives in.
_MODELS = {"report": Report, "explore": SavedExplore, "dashboard": Dashboard}


class FavoriteBody(BaseModel):
    favorite: bool


def _authorized(db: Session, user_id, item_type: str, item_id: str):
    model = _MODELS.get(item_type)
    if model is None:
        # 404 rather than 422: an unknown kind is an unknown URL, and a
        # different status would distinguish "no such kind" from "no
        # such item", which is a hint we do not owe a stranger.
        raise ApiError("HTTP_ERROR", 404, "Not found")
    return require_owned(db, user_id, item_id, model, need="viewer")


@router.post("/api/library/{item_type}/{item_id}/favorite")
def set_favorite(
    item_type: str,
    item_id: str,
    body: FavoriteBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    item = _authorized(db, sess.user_id, item_type, item_id)
    state.set_favorite(db, sess.user_id, item_type, item.id, body.favorite)
    return {"favorite": body.favorite}


@router.post("/api/library/{item_type}/{item_id}/view")
def record_view(
    item_type: str,
    item_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    item = _authorized(db, sess.user_id, item_type, item_id)
    state.record_view(db, sess.user_id, item_type, item.id)
    return {"ok": True}
