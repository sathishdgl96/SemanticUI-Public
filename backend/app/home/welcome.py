"""What to tell somebody who has just signed in for the first time.

The product's empty states are good, and each teaches the *next click*. None
teaches the arc -- semantic view, explore, report, dashboard, Excel -- so a
newcomer learns the shape one dead end at a time. This block is the paragraph
that says it once.

It branches, because advice you cannot act on teaches people to stop reading.
Telling a viewer in somebody else's workspace to build a report is exactly
that. What the user can already *see* decides which advice they get -- not
what they belong to, since a workspace with nothing in it teaches nothing.

Computed here rather than in the browser so the client never has to ask "am I
new?", and carried on the Home payload so it costs no extra round trip.
"""

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import (
    Dashboard,
    Report,
    SavedExplore,
    User,
    WorkspaceMember,
)

#: Which memberships let somebody create things. Viewer is deliberately
#: absent: it is the role for which "make your own report" is not an option.
_AUTHORING_ROLES = ("editor", "admin")


def _workspace_ids(db: Session, user: User) -> list:
    return list(
        db.execute(
            select(WorkspaceMember.workspace_id).where(
                WorkspaceMember.user_id == user.id
            )
        ).scalars()
    )


def _holds_anything(db: Session, workspace_ids: list) -> bool:
    """Is there a single readable item across these workspaces?

    Existence, not a count: the answer is a branch, and a workspace with four
    thousand reports and one deserve the same advice.
    """
    if not workspace_ids:
        return False
    for model in (Report, Dashboard, SavedExplore):
        found = db.execute(
            select(model.id).where(model.workspace_id.in_(workspace_ids)).limit(1)
        ).first()
        if found is not None:
            return True
    return False


def build(db: Session, user: User) -> dict:
    """The welcome block for one user."""
    workspace_ids = _workspace_ids(db, user)
    can_author = bool(
        workspace_ids
        and db.execute(
            select(WorkspaceMember.id).where(
                WorkspaceMember.user_id == user.id,
                WorkspaceMember.role.in_(_AUTHORING_ROLES),
            ).limit(1)
        ).first()
    )
    return {
        # "explore" -- nothing to read yet, so start at a model.
        # "team"    -- their people already have work here; start by reading it.
        "path": "team" if _holds_anything(db, workspace_ids) else "explore",
        "canAuthor": can_author,
        "seen": user.welcomed_at is not None,
    }


def dismiss(db: Session, user: User) -> None:
    """Record that this person has been oriented.

    Idempotent on purpose: a retried request must not restamp the moment,
    which is the one thing the column is for.
    """
    if user.welcomed_at is None:
        user.welcomed_at = datetime.now(timezone.utc)
        db.commit()
