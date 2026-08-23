"""The admin endpoints, behind one gate.

Membership of the admin area comes from the environment, not the
database. The people who may read everyone's activity are decided by
whoever deploys the app; a table row granting it would be a row somebody
inside the app could eventually grant themselves.

Every refusal here is a 403 and is itself audited. Unlike a report -- where
404 hides whether an id exists -- there is nothing to hide about the
existence of an admin area, and an operator who has been left off the list
needs to be told that rather than shown an empty page.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.admin import service
from app.auth.routes import current_session
from app.config import get_settings
from app.db.base import get_db
from app.db.models import DbSession, User
from app.errors import ApiError

router = APIRouter()


def require_app_admin(
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> DbSession:
    user = db.get(User, sess.user_id)
    if not get_settings().is_app_admin(user.snowflake_user if user else None):
        from app.audit import record

        record(
            db,
            "admin.denied",
            user_id=sess.user_id,
            session_id=sess.id,
            outcome="denied",
        )
        raise ApiError(
            "FORBIDDEN",
            403,
            "The admin area is limited to the administrators named in this "
            "deployment's configuration.",
        )
    return sess


@router.get("/api/admin/whoami")
def whoami(
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Whether to draw the admin entry at all.

    Deliberately NOT behind the gate: the answer for a non-admin is
    `false`, which is not a secret, and putting it behind the gate would
    mean every ordinary page load produced an audited denial.
    """
    user = db.get(User, sess.user_id)
    return {
        "isAppAdmin": get_settings().is_app_admin(user.snowflake_user if user else None)
    }


@router.get("/api/admin/health")
def health(
    _: DbSession = Depends(require_app_admin),
    db: Session = Depends(get_db),
) -> dict:
    return service.health(db)


@router.get("/api/admin/events")
def events(
    action: str | None = None,
    outcome: str | None = None,
    user: str | None = None,
    hours: int | None = None,
    limit: int = 100,
    before: str | None = None,
    _: DbSession = Depends(require_app_admin),
    db: Session = Depends(get_db),
) -> dict:
    return service.events(
        db,
        action=action,
        outcome=outcome,
        user=user,
        hours=hours,
        limit=limit,
        before=before,
    )


@router.get("/api/admin/security")
def security(
    hours: int = service.DEFAULT_WINDOW_HOURS,
    _: DbSession = Depends(require_app_admin),
    db: Session = Depends(get_db),
) -> dict:
    # Bounded: an unbounded window would read the whole trail into memory
    # to draw one page.
    return service.security(db, hours=max(1, min(hours, 24 * 14)))
