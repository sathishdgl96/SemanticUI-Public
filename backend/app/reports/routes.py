from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.db.base import get_db
from app.db.models import DbSession, Report, Workspace
from app.reports import service
from app.workspaces.access import membership, require_access
from app.reports.migrate import migrate_definition
from app.reports.schema import parse_definition, to_export_document

router = APIRouter()


class DefinitionBody(BaseModel):
    definition: dict
    #: Optional. Omitted means "my personal workspace", which is what a plain
    #: "New report" should do.
    workspaceId: str | None = None


class MoveBody(BaseModel):
    workspaceId: str


def _summary(report: Report, *, workspace: Workspace | None, role: str) -> dict:
    return {
        "id": str(report.id),
        "name": report.name,
        "view": {
            "database": report.view_database,
            "schema": report.view_schema,
            "name": report.view_name,
        },
        "updatedAt": report.updated_at.isoformat(),
        "workspaceId": str(report.workspace_id),
        "workspaceName": workspace.name if workspace else "",
        #: The caller's role here, so the UI can disable Save with a stated
        #: reason rather than letting them discover it on a 403.
        "myRole": role,
    }


def _detail(report: Report, *, workspace: Workspace | None, role: str) -> dict:
    return {
        **_summary(report, workspace=workspace, role=role),
        #: Migrated on the way OUT, not only on save: v3 is the first
        #: structurally breaking version (`visuals` moved inside `pages`), and
        #: a row stored before the bump must not reach the frontend in a shape
        #: it no longer reads. Migrate only -- running the full validator here
        #: could turn a stored document into an error on read, locking its
        #: owner out of the very screen where they could fix it.
        "definition": migrate_definition(report.definition),
    }


def _context(db: Session, user_id, report: Report) -> tuple[Workspace | None, str]:
    """The workspace a report lives in and the caller's role in it.

    Both are guaranteed present by the time this runs -- require_access has
    already resolved them -- but the lookups are kept defensive so a response
    shaper can never be the thing that raises.
    """
    workspace = db.get(Workspace, report.workspace_id)
    member = membership(db, user_id, report.workspace_id)
    return workspace, member.role if member else ""


@router.get("/api/reports")
def list_reports(
    workspace: str | None = None,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    reports = service.list_reports(db, sess.user_id, workspace)
    out = []
    for report in reports:
        workspace_row, role = _context(db, sess.user_id, report)
        out.append(_summary(report, workspace=workspace_row, role=role))
    return {"reports": out}


@router.post("/api/reports", status_code=201)
def create_report(
    body: DefinitionBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    report = service.create_report(
        db, sess.user_id, body.definition, body.workspaceId
    )
    workspace, role = _context(db, sess.user_id, report)
    return _detail(report, workspace=workspace, role=role)


@router.get("/api/reports/{report_id}")
def get_report(
    report_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    report = require_access(db, sess.user_id, report_id, need="viewer")
    workspace, role = _context(db, sess.user_id, report)
    return _detail(report, workspace=workspace, role=role)


@router.put("/api/reports/{report_id}")
def update_report(
    report_id: str,
    body: DefinitionBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    report = service.update_report(db, sess.user_id, report_id, body.definition)
    workspace, role = _context(db, sess.user_id, report)
    return _detail(report, workspace=workspace, role=role)


@router.delete("/api/reports/{report_id}", status_code=204)
def delete_report(
    report_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    service.delete_report(db, sess.user_id, report_id)
    return Response(status_code=204)


@router.get("/api/reports/{report_id}/export")
def export_report(
    report_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    report = require_access(db, sess.user_id, report_id, need="viewer")
    document = to_export_document(parse_definition(report.definition))
    return Response(content=document, media_type="application/json")


from app.snowflake.provider import get_cache


class ImportBody(BaseModel):
    definition: dict
    viewOverride: dict | None = None
    workspaceId: str | None = None


@router.post("/api/reports/import", status_code=201)
def import_report(
    body: ImportBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    cache = get_cache()
    entry = cache.acquire(db, sess)
    report = service.import_report(
        db, sess.user_id, entry, cache, body.definition, body.viewOverride,
        body.workspaceId,
    )
    workspace, role = _context(db, sess.user_id, report)
    return _detail(report, workspace=workspace, role=role)


@router.post("/api/reports/{report_id}/move")
def move_report(
    report_id: str,
    body: MoveBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    report = service.move_report(db, sess.user_id, report_id, body.workspaceId)
    workspace, role = _context(db, sess.user_id, report)
    return _detail(report, workspace=workspace, role=role)
