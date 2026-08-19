"""Report CRUD, import and move -- always inside the caller's workspaces.

Membership is checked at the single workspace gate (non-members get
404, so existence never leaks); owner_user_id is provenance only,
never authorization. Imports re-validate every field reference against
the live DESCRIBE before a definition is accepted.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Report, Workspace, WorkspaceMember
from app.errors import ApiError
from app.reports.schema import ReportDefinition, parse_definition
from app.workspaces.access import require_access, require_workspace


def list_reports(
    db: Session, user_id: uuid.UUID, workspace_id: str | None = None
) -> list[Report]:
    """Every report in every workspace this user belongs to.

    Joined through membership rather than filtered on `owner_user_id`: a
    shared report is not owned by the person reading it.
    """
    query = (
        select(Report)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Report.workspace_id)
        .where(WorkspaceMember.user_id == user_id)
        .order_by(Report.updated_at.desc())
    )
    if workspace_id:
        # Through require_workspace, so a bogus or unauthorised id is a 404
        # rather than a silently empty list that reads as "no reports here".
        workspace = require_workspace(db, user_id, workspace_id, need="viewer")
        query = query.where(Report.workspace_id == workspace.id)
    return list(db.scalars(query))


def personal_workspace_id(db: Session, user_id: uuid.UUID) -> uuid.UUID:
    workspace = db.scalar(
        select(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user_id, Workspace.kind == "personal")
    )
    if workspace is None:
        # Every login creates one, so reaching here means the session outlived
        # a database reset. An explicit error beats a null workspace_id.
        raise ApiError(
            "HTTP_ERROR", 404, "You have no personal workspace; sign in again."
        )
    return workspace.id


def _resolve_target(
    db: Session, user_id: uuid.UUID, workspace_id: str | None
) -> uuid.UUID:
    """Where a new report should land: the named workspace, or mine."""
    if workspace_id:
        return require_workspace(db, user_id, workspace_id, need="editor").id
    return personal_workspace_id(db, user_id)


def _apply(report: Report, definition: ReportDefinition) -> None:
    report.name = definition.name
    report.view_database = definition.view.database
    report.view_schema = definition.view.schema_
    report.view_name = definition.view.name
    report.definition = definition.model_dump(by_alias=True, mode="json")


def create_report(
    db: Session,
    user_id: uuid.UUID,
    raw_definition: dict,
    workspace_id: str | None = None,
) -> Report:
    target = _resolve_target(db, user_id, workspace_id)
    definition = parse_definition(raw_definition)
    report = Report(owner_user_id=user_id, workspace_id=target, name=definition.name,
                    view_database="", view_schema="", view_name="", definition={})
    _apply(report, definition)
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


def update_report(
    db: Session, user_id: uuid.UUID, report_id: str, raw_definition: dict
) -> Report:
    report = require_access(db, user_id, report_id, need="editor")
    _apply(report, parse_definition(raw_definition))
    db.commit()
    db.refresh(report)
    return report


def delete_report(db: Session, user_id: uuid.UUID, report_id: str) -> None:
    report = require_access(db, user_id, report_id, need="editor")
    db.delete(report)
    db.commit()


from app.reports.catalog import wells_to_query


def _known_refs(detail: dict) -> set[str]:
    """Every field reference this user's role can actually see, upper-cased."""
    refs: set[str] = set()
    for kind in ("dimensions", "metrics", "facts"):
        for field in detail.get(kind, []):
            table = (field.get("table") or "").upper()
            name = (field.get("name") or "").upper()
            refs.add(f"{table}.{name}")
    return refs


def import_report(
    db: Session,
    user_id: uuid.UUID,
    entry,
    cache,
    raw_definition: dict,
    view_override: dict | None = None,
    workspace_id: str | None = None,
) -> Report:
    """Create a report from an untrusted definition document.

    Every field reference is re-validated against a live DESCRIBE on the
    importing user's own connection, so an imported report can only reference
    fields their Snowflake role can see.
    """
    target = _resolve_target(db, user_id, workspace_id)

    if view_override:
        raw_definition = {**raw_definition, "view": view_override}

    definition = parse_definition(raw_definition)

    if not (definition.view.database and definition.view.schema_ and definition.view.name):
        # An unbound definition can pass `parse_definition` (an empty view
        # with no visuals is legitimate for a fresh report), but importing
        # one is meaningless: there is nothing to DESCRIBE and validate
        # field references against.
        raise ApiError(
            "REPORT_INVALID",
            400,
            "This definition has no semantic view bound and no viewOverride "
            "was supplied. Provide a view override to import it.",
        )

    with entry.lock:
        detail = cache.describe(
            entry,
            definition.view.database,
            definition.view.schema_,
            definition.view.name,
        )

    known = _known_refs(detail)
    hierarchy_levels = {h.id: list(h.levels) for h in definition.hierarchies}

    missing: list[str] = []
    # Report-scope filters first, then each visual's fields and its own
    # filters. A filter reference is exactly as sensitive as a well reference:
    # both name a field this user's role must be able to see.
    for f in definition.filters:
        if f.field.upper() not in known:
            missing.append(f.field)
    for page in definition.pages:
        # A page filter names a field exactly as a well or visual filter does.
        for f in page.filters:
            if f.field.upper() not in known:
                missing.append(f.field)
        for visual in page.visuals:
            # Passing the hierarchy map expands "hierarchy:h1" into every level,
            # so a level the importer cannot see fails the import now rather than
            # lying dormant until someone drills into it.
            dimensions, metrics = wells_to_query(
                visual.type, visual.wells, hierarchies=hierarchy_levels
            )
            for ref in dimensions + metrics:
                if ref.upper() not in known:
                    missing.append(ref)
            for f in visual.filters:
                if f.field.upper() not in known:
                    missing.append(f.field)
    if missing:
        unique = sorted(set(missing))
        raise ApiError(
            "REPORT_INVALID",
            400,
            "This report references fields that do not exist in the target view, "
            "or that your Snowflake role cannot see: " + ", ".join(unique),
        )

    report = Report(owner_user_id=user_id, workspace_id=target, name=definition.name,
                    view_database="", view_schema="", view_name="", definition={})
    _apply(report, definition)
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


def move_report(
    db: Session, user_id: uuid.UUID, report_id: str, workspace_id: str
) -> Report:
    """Move a report to another workspace.

    Editor on BOTH ends. Requiring it only on the destination would let anyone
    lift a report out of a workspace they were merely shown; requiring it only
    on the source would let them push one into a workspace they cannot write
    to. Either half alone is a hole.
    """
    report = require_access(db, user_id, report_id, need="editor")
    destination = require_workspace(db, user_id, workspace_id, need="editor")
    report.workspace_id = destination.id
    db.commit()
    db.refresh(report)
    return report
