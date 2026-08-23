"""Workspace and membership operations, including the guard rails.

The guard rails live here rather than in routes.py because they are rules
about the data, not about HTTP -- and a rule enforced only in one route is a
rule the next route forgets.
"""

import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Report, User, Workspace, WorkspaceMember
from app.errors import ApiError
from app.workspaces.access import as_uuid, membership, require_workspace

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


def _reject_personal(workspace: Workspace, action: str) -> None:
    """A personal workspace is a person, not a group.

    Renaming it, deleting it, or adding someone to it would quietly turn "my
    private drafts" into something else. Enforced here rather than by hiding a
    button, because a hidden button is not a rule.
    """
    if workspace.kind == "personal":
        raise ApiError(
            "REPORT_INVALID",
            400,
            f"A personal workspace cannot be {action}. Create a shared "
            "workspace to collaborate.",
        )


def create_workspace(
    db: Session, user_id: uuid.UUID, account: str, name: str
) -> Workspace:
    workspace = Workspace(name=name, kind="shared", snowflake_account=account)
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user_id, role="admin"))
    db.commit()
    db.refresh(workspace)
    return workspace


def rename_workspace(
    db: Session, user_id: uuid.UUID, workspace_id: str, name: str
) -> Workspace:
    workspace = require_workspace(db, user_id, workspace_id, need="admin")
    _reject_personal(workspace, "renamed")
    workspace.name = name
    db.commit()
    db.refresh(workspace)
    return workspace


def delete_workspace(db: Session, user_id: uuid.UUID, workspace_id: str) -> None:
    workspace = require_workspace(db, user_id, workspace_id, need="admin")
    _reject_personal(workspace, "deleted")
    # Deleted explicitly rather than relying on ondelete="CASCADE": SQLite does
    # not enforce foreign keys unless PRAGMA foreign_keys is on, so the cascade
    # that works on Postgres would silently leave orphans in dev and in tests.
    db.query(Report).filter(Report.workspace_id == workspace.id).delete()
    db.query(WorkspaceMember).filter(
        WorkspaceMember.workspace_id == workspace.id
    ).delete()
    db.delete(workspace)
    db.commit()


def _admin_count(db: Session, workspace_id: uuid.UUID) -> int:
    return (
        db.scalar(
            select(func.count())
            .select_from(WorkspaceMember)
            .where(
                WorkspaceMember.workspace_id == workspace_id,
                WorkspaceMember.role == "admin",
            )
        )
        or 0
    )


def _guard_last_admin(db: Session, member: WorkspaceMember, action: str) -> None:
    """A workspace whose last admin is removed or demoted can never have its
    membership changed again -- there is nobody left who may change it.

    Covers demotion as well as removal, and applies to a user acting on
    themselves: "I'll just leave" is the most likely way to reach the state.
    """
    if member.role != "admin":
        return
    if _admin_count(db, member.workspace_id) > 1:
        return
    raise ApiError(
        "REPORT_INVALID",
        400,
        f"This is the last admin of the workspace, so they cannot be {action}. "
        "Promote another member to admin first.",
    )


def _member_or_404(
    db: Session, workspace_id: uuid.UUID, member_user_id: str
) -> WorkspaceMember:
    key = as_uuid(member_user_id)
    member = (
        db.scalar(
            select(WorkspaceMember).where(
                WorkspaceMember.workspace_id == workspace_id,
                WorkspaceMember.user_id == key,
            )
        )
        if key
        else None
    )
    if member is None:
        raise ApiError("HTTP_ERROR", 404, "Not a member of this workspace")
    return member


def add_member(
    db: Session,
    user_id: uuid.UUID,
    workspace_id: str,
    snowflake_user: str,
    role: str,
    snowflake_account: str | None = None,
) -> WorkspaceMember:
    workspace = require_workspace(db, user_id, workspace_id, need="admin")
    _reject_personal(workspace, "given members")

    account = snowflake_account or workspace.snowflake_account
    if account.upper() != workspace.snowflake_account.upper():
        raise ApiError(
            "REPORT_INVALID",
            400,
            f"{snowflake_user} is in Snowflake account {account}, but this "
            f"workspace belongs to {workspace.snowflake_account}. Their "
            "credentials could not read its reports.",
        )

    target = db.scalar(
        select(User).where(
            User.snowflake_account == workspace.snowflake_account,
            User.snowflake_user == snowflake_user,
        )
    )
    if target is None:
        # Created on demand: requiring a colleague to log in before you may
        # share with them makes sharing useless for onboarding.
        target = User(
            snowflake_account=workspace.snowflake_account,
            snowflake_user=snowflake_user,
        )
        db.add(target)
        db.flush()

    if membership(db, target.id, workspace.id) is not None:
        raise ApiError("REPORT_INVALID", 400, f"{snowflake_user} is already a member.")

    member = WorkspaceMember(workspace_id=workspace.id, user_id=target.id, role=role)
    db.add(member)
    db.commit()
    db.refresh(member)
    return member


def set_member_role(
    db: Session, user_id: uuid.UUID, workspace_id: str, member_user_id: str, role: str
) -> WorkspaceMember:
    workspace = require_workspace(db, user_id, workspace_id, need="admin")
    member = _member_or_404(db, workspace.id, member_user_id)
    # Only a real demotion trips the guard: re-setting the role someone already
    # holds must not be an error.
    if role != "admin":
        _guard_last_admin(db, member, "demoted")
    member.role = role
    db.commit()
    db.refresh(member)
    return member


def remove_member(
    db: Session, user_id: uuid.UUID, workspace_id: str, member_user_id: str
) -> None:
    workspace = require_workspace(db, user_id, workspace_id, need="admin")
    member = _member_or_404(db, workspace.id, member_user_id)
    _guard_last_admin(db, member, "removed")
    db.delete(member)
    db.commit()
