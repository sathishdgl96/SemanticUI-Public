import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Report
from app.errors import ApiError
from app.reports.schema import ReportDefinition, parse_definition


def _not_found() -> ApiError:
    # 404 rather than 403: a non-owner must not learn that this id exists.
    return ApiError("HTTP_ERROR", 404, "Report not found")


def list_reports(db: Session, user_id: uuid.UUID) -> list[Report]:
    return list(
        db.scalars(
            select(Report)
            .where(Report.owner_user_id == user_id)
            .order_by(Report.updated_at.desc())
        )
    )


def get_owned_report(db: Session, user_id: uuid.UUID, report_id: str) -> Report:
    try:
        key = uuid.UUID(str(report_id))
    except (ValueError, AttributeError):
        raise _not_found()
    report = db.get(Report, key)
    if report is None or report.owner_user_id != user_id:
        raise _not_found()
    return report


def _apply(report: Report, definition: ReportDefinition) -> None:
    report.name = definition.name
    report.view_database = definition.view.database
    report.view_schema = definition.view.schema_
    report.view_name = definition.view.name
    report.definition = definition.model_dump(by_alias=True, mode="json")


def create_report(db: Session, user_id: uuid.UUID, raw_definition: dict) -> Report:
    definition = parse_definition(raw_definition)
    report = Report(owner_user_id=user_id, name=definition.name,
                    view_database="", view_schema="", view_name="", definition={})
    _apply(report, definition)
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


def update_report(
    db: Session, user_id: uuid.UUID, report_id: str, raw_definition: dict
) -> Report:
    report = get_owned_report(db, user_id, report_id)
    _apply(report, parse_definition(raw_definition))
    db.commit()
    db.refresh(report)
    return report


def delete_report(db: Session, user_id: uuid.UUID, report_id: str) -> None:
    report = get_owned_report(db, user_id, report_id)
    db.delete(report)
    db.commit()


from app.reports.catalog import wells_to_query
from app.reports.schema import MAX_DEFINITION_BYTES


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
) -> Report:
    """Create a report from an untrusted definition document.

    Every field reference is re-validated against a live DESCRIBE on the
    importing user's own connection, so an imported report can only reference
    fields their Snowflake role can see.
    """
    import json as _json

    if len(_json.dumps(raw_definition)) > MAX_DEFINITION_BYTES:
        raise ApiError(
            "REPORT_INVALID",
            400,
            f"The definition exceeds the {MAX_DEFINITION_BYTES} byte limit",
        )

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
    missing: list[str] = []
    for visual in definition.visuals:
        dimensions, metrics = wells_to_query(visual.type, visual.wells)
        for ref in dimensions + metrics:
            if ref.upper() not in known:
                missing.append(ref)
    if missing:
        unique = sorted(set(missing))
        raise ApiError(
            "REPORT_INVALID",
            400,
            "This report references fields that do not exist in the target view, "
            "or that your Snowflake role cannot see: " + ", ".join(unique),
        )

    report = Report(owner_user_id=user_id, name=definition.name,
                    view_database="", view_schema="", view_name="", definition={})
    _apply(report, definition)
    db.add(report)
    db.commit()
    db.refresh(report)
    return report
