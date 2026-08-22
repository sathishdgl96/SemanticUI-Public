"""/api/reports: the HTTP shell around reports.service.

Routes stay thin -- resolve the session, call the service, record the
audit event. Denials are recorded value-free at the gate.
"""

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.db.base import get_db
from app.db.models import DbSession, Report, Workspace
from app.library import provenance, state
from app.library import search as search_module
from app.library.search import LibraryQuery
from app.reports import service
from app.workspaces.access import (
    membership,
    require_access,
    roles_for,
    workspaces_by_id,
)
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


def _summary(
    report: Report, *, workspace: Workspace | None, role: str, creator: str = ""
) -> dict:
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
        #: Who made it. Provenance, never permission -- membership alone
        #: decides who may read it (ADR 0009).
        "createdBy": creator,
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
    q: str | None = None,
    favorite: bool = False,
    role: str | None = None,
    sort: str = "recent",
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    params = LibraryQuery(q=q, favorite=favorite, role=role, sort=sort)
    reports = service.list_reports(db, sess.user_id, workspace, params)
    # The service asks for one more than the cap so this can tell the
    # difference between "exactly the cap" and "there are more".
    truncated = len(reports) > search_module.MAX_ROWS
    reports = reports[: search_module.MAX_ROWS]
    favorites = state.favorite_ids(db, sess.user_id, "report")
    recents = state.recent_order(db, sess.user_id, "report")
    creators = provenance.creator_names(db, [r.owner_user_id for r in reports])
    # Prefetched rather than looked up per row: `_context` costs two
    # queries a report, which is one round trip for the list and two
    # hundred more for a hundred reports.
    roles = roles_for(db, sess.user_id)
    spaces = workspaces_by_id(db, [r.workspace_id for r in reports])
    out = []
    for report in reports:
        workspace_row = spaces.get(report.workspace_id)
        member_role = roles.get(report.workspace_id, "")
        summary = _summary(
            report,
            workspace=workspace_row,
            role=member_role,
            creator=creators.get(report.owner_user_id, ""),
        )
        summary["favorite"] = report.id in favorites
        seen = recents.get(report.id)
        summary["lastViewedAt"] = seen.isoformat() if seen else None
        out.append(summary)
    return {"reports": out, "truncated": truncated}


@router.post("/api/reports", status_code=201)
def create_report(
    body: DefinitionBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    report = service.create_report(
        db, sess.user_id, body.definition, body.workspaceId
    )
    from app.audit import record

    record(db, "report.create", user_id=sess.user_id, session_id=sess.id,
           resource_type="report", resource_id=report.id)
    workspace, role = _context(db, sess.user_id, report)
    return _detail(report, workspace=workspace, role=role)


@router.get("/api/reports/{report_id}")
def get_report(
    report_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    report = require_access(db, sess.user_id, report_id, need="viewer")
    from app.audit import record

    record(db, "report.read", user_id=sess.user_id, session_id=sess.id,
           resource_type="report", resource_id=report.id)
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
    from app.audit import record

    record(db, "report.update", user_id=sess.user_id, session_id=sess.id,
           resource_type="report", resource_id=report.id)
    workspace, role = _context(db, sess.user_id, report)
    return _detail(report, workspace=workspace, role=role)


@router.delete("/api/reports/{report_id}", status_code=204)
def delete_report(
    report_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    service.delete_report(db, sess.user_id, report_id)
    from app.audit import record

    record(db, "report.delete", user_id=sess.user_id, session_id=sess.id,
           resource_type="report", resource_id=report_id)
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


@router.get("/api/reports/{report_id}/provenance")
def report_provenance(
    report_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    """The About page: what this report is built on, and how current it is.

    The blocks are assembled rather than fetched together on purpose. A model
    can be certified while its freshness is unreadable -- a stopped warehouse
    is the ordinary case -- and the page has to render either way, so
    `source_freshness` reports its own unavailability instead of raising.
    """
    from app.reports import provenance
    from app.semantic import certification
    from app.semantic.freshness import source_freshness

    report = require_access(db, sess.user_id, report_id, need="viewer")
    view = {
        "database": report.view_database,
        "schema": report.view_schema,
        "name": report.view_name,
    }

    cache = get_cache()
    entry = cache.acquire(db, sess)
    with entry.lock:
        detail = cache.describe(entry, *view.values())
        freshness = source_freshness(entry.conn, detail.get("tables", []))

    return provenance.build(
        view=view,
        record=certification.get(db, *view.values()),
        freshness=freshness,
    )
