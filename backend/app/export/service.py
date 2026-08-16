"""Run each sheet's query on the caller's connection, then build the workbook."""

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import DbSession
from app.errors import ApiError
from app.export.literals import build_literal_sql
from app.export.workbook import SheetData, build_workbook
from app.reports.filters import is_active
from app.semantic.query import SemanticQueryRequest, build_semantic_sql
from app.snowflake import gateway
from app.snowflake.provider import get_cache
from app.workspaces.access import require_access


def _request(report, sheet: dict) -> SemanticQueryRequest:
    return SemanticQueryRequest.model_validate(
        {
            "database": report.view_database,
            "schema": report.view_schema,
            "view": report.view_name,
            "dimensions": sheet.get("dimensions") or [],
            "metrics": sheet.get("metrics") or [],
            "filters": sheet.get("filters") or [],
            "orderBy": sheet.get("orderBy") or [],
        }
    )


def _describe_filters(request: SemanticQueryRequest) -> list[str]:
    return [f"{f.field} {f.op}" for f in request.filters if is_active(f)]


def _prepare(db: Session, sess: DbSession, report_id: str):
    # viewer: exporting and copying SQL are both reading.
    report = require_access(db, sess.user_id, report_id, need="viewer")
    if not report.view_name:
        raise ApiError(
            "REPORT_INVALID",
            400,
            "This report is not bound to a semantic view, so there is nothing "
            "to export.",
        )
    cache = get_cache()
    return report, cache, cache.acquire(db, sess)


def export_workbook(
    db: Session, sess: DbSession, report_id: str, sheets: list[dict]
) -> tuple[str, bytes]:
    report, cache, entry = _prepare(db, sess, report_id)
    settings = get_settings()

    built: list[SheetData] = []
    with entry.lock:
        detail = cache.describe(
            entry, report.view_database, report.view_schema, report.view_name
        )
        for sheet in sheets:
            # Validation errors are NOT caught: an unknown field is a client
            # bug and must be loud. Only EXECUTION failures degrade a sheet.
            request = _request(report, sheet)
            sql, params, limit = build_semantic_sql(
                detail, request, max_rows=settings.export_row_cap
            )
            common = {
                "title": sheet.get("title") or "Sheet",
                "context": sheet.get("context") or "",
                "filters": _describe_filters(request),
            }
            try:
                result = gateway.run_query(
                    entry.conn, sql, max_rows=limit, params=params
                )
            except ApiError as exc:
                # One visual the viewer's Snowflake role cannot read must not
                # cost them the whole workbook.
                built.append(
                    SheetData(columns=[], rows=[], error=exc.message, **common)
                )
                continue
            built.append(SheetData(columns=result.columns, rows=result.rows, **common))

    data = build_workbook(
        report.name,
        f"{report.view_database}.{report.view_schema}.{report.view_name}",
        sess.user.snowflake_user,
        built,
        generated_at=datetime.now(timezone.utc),
    )
    return report.name, data


def connection_details(
    db: Session, sess: DbSession, report_id: str, sheets: list[dict]
) -> dict:
    report, cache, entry = _prepare(db, sess, report_id)
    with entry.lock:
        detail = cache.describe(
            entry, report.view_database, report.view_schema, report.view_name
        )
        out = [
            {
                "title": sheet.get("title") or "Sheet",
                "sql": build_literal_sql(detail, _request(report, sheet)),
            }
            for sheet in sheets
        ]
    return {
        "account": sess.user.snowflake_account,
        "database": report.view_database,
        "schema": report.view_schema,
        "view": report.view_name,
        "sheets": out,
    }
