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
