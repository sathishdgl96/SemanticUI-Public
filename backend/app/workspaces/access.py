"""The only place an authorization decision is made.

Two rules, and they differ deliberately:

  * No membership at all -> 404. A non-member must not be able to tell
    "does not exist" from "exists and is not yours".
  * Membership with too low a role -> 403. They already know it exists, so a
    404 here would be a lie that helps nobody.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Report, Workspace, WorkspaceMember
from app.errors import ApiError
from app.workspaces.roles import at_least


def _not_found() -> ApiError:
    return ApiError("HTTP_ERROR", 404, "Not found")


def _forbidden(need: str, actual: str) -> ApiError:
    return ApiError(
        "WORKSPACE_FORBIDDEN",
        403,
        f"This action needs the {need} role in this workspace; you have {actual}.",
    )


def as_uuid(value: str) -> uuid.UUID | None:
    """Parse an id from the URL, or None. A malformed id is a 404, never a 500."""
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def membership(
    db: Session, user_id: uuid.UUID, workspace_id: uuid.UUID
) -> WorkspaceMember | None:
    return db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.user_id == user_id,
        )
    )


def require_workspace(
    db: Session, user_id: uuid.UUID, workspace_id: str, *, need: str
) -> Workspace:
    key = as_uuid(workspace_id)
    if key is None:
        raise _not_found()
    workspace = db.get(Workspace, key)
    if workspace is None:
        raise _not_found()
    member = membership(db, user_id, workspace.id)
    if member is None:
        raise _not_found()
    if not at_least(member.role, need):
        raise _forbidden(need, member.role)
    return workspace


def require_owned(
    db: Session, user_id: uuid.UUID, entity_id: str, model: type, *, need: str
):
    """Resolve any workspace-owned row -> workspace -> membership, or raise.

    `owner_user_id` is deliberately not consulted anywhere here: it records
    who CREATED the row, not who may read it, so removing someone from a
    workspace actually removes their access.

    Generic over the model because reports and saved explores are governed by
    exactly the same rule, and two copies of an authorization check is one
    copy too many -- the second is where the drift starts.
    """
    from app.audit import record

    resource = model.__tablename__
    key = as_uuid(entity_id)
    if key is None:
        raise _not_found()
    row = db.get(model, key)
    if row is None:
        raise _not_found()
    member = membership(db, user_id, row.workspace_id)
    if member is None:
        # The one audit-worthy denial: a real resource, a real user, no
        # membership. (A garbage id is noise, not signal.)
        record(db, "access.denied", user_id=user_id, resource_type=resource,
               resource_id=key, outcome="denied")
        raise _not_found()
    if not at_least(member.role, need):
        record(db, "access.denied", user_id=user_id, resource_type=resource,
               resource_id=key, outcome="forbidden",
               detail={"need": need, "role": member.role})
        raise _forbidden(need, member.role)
    return row


def require_access(
    db: Session, user_id: uuid.UUID, report_id: str, *, need: str
) -> Report:
    """Resolve report -> workspace -> membership, or raise."""
    return require_owned(db, user_id, report_id, Report, need=need)
