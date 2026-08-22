"""Home: the last few things you opened, and the dashboard you chose.

One request for both halves. The page has nothing to show without each of
them, and two round trips would only stagger the arrival.
"""

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.dashboards import service as dashboards
from app.db.base import get_db
from app.db.models import DbSession, User
from app.home import service, welcome

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
        # Which orientation this person needs, decided here so the browser
        # never has to ask "am I new?" -- and carried on this payload so it
        # costs no round trip of its own.
        "welcome": welcome.build(db, db.get(User, sess.user_id)),
    }


@router.post("/api/home/welcome/dismiss", status_code=204)
def dismiss_welcome(
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    """One deliberate interruption at minute zero, and then silence."""
    welcome.dismiss(db, db.get(User, sess.user_id))
    return Response(status_code=204)
