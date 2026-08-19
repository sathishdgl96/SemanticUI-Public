"""/api/workspaces: create/rename/delete and membership administration.

Non-members see 404, members below the required role see 403 -- the
API never reveals which workspaces exist to those outside them.
"""

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.db.base import get_db
from app.db.models import DbSession, Report, User, Workspace, WorkspaceMember
from app.workspaces import service
from app.workspaces.access import require_workspace

router = APIRouter()


class WorkspaceBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)


def _counts(db: Session, workspace: Workspace) -> tuple[int, int]:
    members = db.scalar(
        select(func.count())
        .select_from(WorkspaceMember)
        .where(WorkspaceMember.workspace_id == workspace.id)
    )
    reports = db.scalar(
        select(func.count())
        .select_from(Report)
        .where(Report.workspace_id == workspace.id)
    )
    return members or 0, reports or 0


def _row(db: Session, workspace: Workspace, role: str) -> dict:
    members, reports = _counts(db, workspace)
    return {
        "id": str(workspace.id),
        "name": workspace.name,
        "kind": workspace.kind,
        "myRole": role,
        "memberCount": members,
        "reportCount": reports,
    }


@router.get("/api/workspaces")
def list_workspaces(
    sess: DbSession = Depends(current_session), db: Session = Depends(get_db)
) -> dict:
    rows = db.execute(
        select(Workspace, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == sess.user_id)
        # Personal first, then alphabetical. Ordered on the boolean rather than
        # on `kind` itself: relying on "personal" < "shared" would be a
        # coincidence of spelling, and would silently reorder if either name
        # ever changed.
        .order_by((Workspace.kind != "personal"), Workspace.name)
    ).all()
    return {"workspaces": [_row(db, workspace, role) for workspace, role in rows]}


@router.post("/api/workspaces", status_code=201)
def create_workspace(
    body: WorkspaceBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    workspace = service.create_workspace(
        db, sess.user_id, sess.user.snowflake_account, body.name
    )
    return _row(db, workspace, "admin")


@router.patch("/api/workspaces/{workspace_id}")
def rename_workspace(
    workspace_id: str,
    body: WorkspaceBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    workspace = service.rename_workspace(db, sess.user_id, workspace_id, body.name)
    return _row(db, workspace, "admin")


@router.delete("/api/workspaces/{workspace_id}", status_code=204)
def delete_workspace(
    workspace_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    service.delete_workspace(db, sess.user_id, workspace_id)
    return Response(status_code=204)


class AddMemberBody(BaseModel):
    snowflakeUser: str = Field(min_length=1, max_length=255)
    #: A closed enum, so an unknown role is a 422 at the edge rather than a
    #: string that quietly satisfies nothing later.
    role: Literal["viewer", "editor", "admin"]
    #: Only ever used to REJECT a cross-account grant explicitly. Membership is
    #: always created in the workspace's own account.
    snowflakeAccount: str | None = None


class RoleBody(BaseModel):
    role: Literal["viewer", "editor", "admin"]


def _member_row(db: Session, member: WorkspaceMember, me: uuid.UUID) -> dict:
    user = db.get(User, member.user_id)
    return {
        "userId": str(member.user_id),
        "snowflakeUser": user.snowflake_user if user else "",
        "role": member.role,
        "isMe": member.user_id == me,
    }


@router.get("/api/workspaces/{workspace_id}/members")
def list_members(
    workspace_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    # viewer, not admin: knowing who your work is visible to is not a
    # privileged question.
    workspace = require_workspace(db, sess.user_id, workspace_id, need="viewer")
    members = db.scalars(
        select(WorkspaceMember).where(WorkspaceMember.workspace_id == workspace.id)
    )
    return {"members": [_member_row(db, m, sess.user_id) for m in members]}


@router.post("/api/workspaces/{workspace_id}/members", status_code=201)
def add_member(
    workspace_id: str,
    body: AddMemberBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    member = service.add_member(
        db,
        sess.user_id,
        workspace_id,
        body.snowflakeUser,
        body.role,
        body.snowflakeAccount,
    )
    return _member_row(db, member, sess.user_id)


@router.patch("/api/workspaces/{workspace_id}/members/{member_user_id}")
def set_member_role(
    workspace_id: str,
    member_user_id: str,
    body: RoleBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    member = service.set_member_role(
        db, sess.user_id, workspace_id, member_user_id, body.role
    )
    return _member_row(db, member, sess.user_id)


@router.delete(
    "/api/workspaces/{workspace_id}/members/{member_user_id}", status_code=204
)
def remove_member(
    workspace_id: str,
    member_user_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    service.remove_member(db, sess.user_id, workspace_id, member_user_id)
    return Response(status_code=204)
