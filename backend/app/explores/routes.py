"""/api/explores: list/create/get/update/delete/export saved explores."""

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.db.base import get_db
from app.db.models import DbSession, SavedExplore, Workspace
from app.explores import service
from app.explores.schema import parse_definition, to_export_document
from app.workspaces.access import membership

router = APIRouter()


class DefinitionBody(BaseModel):
    definition: dict
    #: Absent means the caller's personal workspace, which is what a bare
    #: "Save explore" should do.
    workspaceId: str | None = None


def _summary(explore: SavedExplore, *, workspace: Workspace | None, role: str) -> dict:
    return {
        "id": str(explore.id),
        "name": explore.name,
        "view": {
            "database": explore.view_database,
            "schema": explore.view_schema,
            "name": explore.view_name,
        },
        "updatedAt": explore.updated_at.isoformat(),
        "workspaceId": str(explore.workspace_id),
        "workspaceName": workspace.name if workspace else "",
        #: The caller's role here, so the UI can disable an action with a
        #: stated reason rather than letting them discover it on a 403.
        "myRole": role,
    }


def _detail(explore: SavedExplore, *, workspace: Workspace | None, role: str) -> dict:
    return {
        **_summary(explore, workspace=workspace, role=role),
        "definition": explore.definition,
    }


def _context(db: Session, user_id, explore: SavedExplore) -> tuple[Workspace | None, str]:
    workspace = db.get(Workspace, explore.workspace_id)
    member = membership(db, user_id, explore.workspace_id)
    return workspace, member.role if member else ""


@router.get("/api/explores")
def list_explores(
    workspace: str | None = None,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    out = []
    for explore in service.list_explores(db, sess.user_id, workspace):
        workspace_row, role = _context(db, sess.user_id, explore)
        out.append(_summary(explore, workspace=workspace_row, role=role))
    return {"explores": out}


@router.post("/api/explores", status_code=201)
def create_explore(
    body: DefinitionBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    explore = service.create_explore(
        db, sess.user_id, body.definition, body.workspaceId
    )
    workspace, role = _context(db, sess.user_id, explore)
    return _detail(explore, workspace=workspace, role=role)


@router.get("/api/explores/{explore_id}")
def get_explore(
    explore_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    explore = service.get_explore(db, sess.user_id, explore_id)
    workspace, role = _context(db, sess.user_id, explore)
    return _detail(explore, workspace=workspace, role=role)


@router.put("/api/explores/{explore_id}")
def update_explore(
    explore_id: str,
    body: DefinitionBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    explore = service.update_explore(db, sess.user_id, explore_id, body.definition)
    workspace, role = _context(db, sess.user_id, explore)
    return _detail(explore, workspace=workspace, role=role)


@router.delete("/api/explores/{explore_id}", status_code=204)
def delete_explore(
    explore_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    service.delete_explore(db, sess.user_id, explore_id)
    return Response(status_code=204)


@router.get("/api/explores/{explore_id}/export")
def export_explore(
    explore_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    """The portable document, byte-stable across two exports of one explore."""
    explore = service.get_explore(db, sess.user_id, explore_id)
    document = to_export_document(parse_definition(explore.definition))
    return Response(content=document, media_type="application/json")
