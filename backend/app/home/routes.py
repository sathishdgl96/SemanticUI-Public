"""Home: the last few things you opened, and the dashboard you chose.

One request for both halves. The page has nothing to show without each of
them, and two round trips would only stagger the arrival.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.dashboards import service as dashboards
from app.db.base import get_db
from app.db.models import DbSession
from app.home import service

router = APIRouter()


@router.get("/api/home")
def get_home(
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    return {
        "recent": service.recent_items(db, sess.user_id),
        # None covers every way a choice can stop being valid: never made,
        # the dashboard deleted, the workspace left. All three mean the
        # same thing to the page, which offers to choose one.
        "dashboard": dashboards.home_dashboard(db, sess.user_id),
    }
