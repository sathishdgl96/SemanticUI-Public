"""Workspace and membership operations, including the guard rails.

The guard rails live here rather than in routes.py because they are rules
about the data, not about HTTP -- and a rule enforced only in one route is a
rule the next route forgets.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import User, Workspace, WorkspaceMember

PERSONAL_WORKSPACE_NAME = "My reports"


def ensure_personal_workspace(db: Session, user: User) -> Workspace:
    """Get or create this user's private workspace.

    Called on every login rather than from the migration, so a user who has
    never signed in does not accumulate a workspace they may never use, and a
    user added as a member before their first login still resolves.
    """
    existing = db.scalar(
        select(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user.id, Workspace.kind == "personal")
    )
    if existing is not None:
        return existing

    workspace = Workspace(
        name=PERSONAL_WORKSPACE_NAME,
        kind="personal",
        snowflake_account=user.snowflake_account,
    )
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="admin"))
    db.flush()
    return workspace
