"""Orchestrates one question.

describe -> prompt -> model -> parse -> validate -> execute.

The model sits in the middle and is trusted for exactly one thing: proposing
field names, which are then checked against the catalog before anything runs.
"""

from typing import Any

from sqlalchemy.orm import Session

from app.config import get_settings
from app.cortex.prompt import build_prompt
from app.cortex.spec import AskSpec, parse_spec, validate_against_catalog
from app.db.models import DbSession
from app.errors import ApiError
from app.semantic.query import SemanticQueryRequest, build_semantic_sql
from app.snowflake import gateway
from app.snowflake.provider import get_cache
from app.workspaces.access import require_access


def _to_query(report, spec: AskSpec) -> SemanticQueryRequest:
    """The model's spec, re-expressed as the request a human's clicks make.

    Everything downstream -- identifier validation, bound parameters, the row
    cap -- is then the code that already existed, unchanged.
    """
    return SemanticQueryRequest.model_validate(
        {
            "database": report.view_database,
            "schema": report.view_schema,
            "view": report.view_name,
            "dimensions": spec.dimensions,
            "metrics": spec.metrics,
            "filters": [f.model_dump(by_alias=True) for f in spec.filters],
            "orderBy": [o.model_dump() for o in spec.orderBy],
            "limit": spec.limit,
        }
    )


def ask(
    db: Session,
    sess: DbSession,
    report_id: str,
    question: str,
    *,
    history: list | None = None,
    provider: Any,
) -> dict:
    settings = get_settings()
    if not settings.ask_enabled:
        raise ApiError(
            "CORTEX_UNAVAILABLE", 503, "Asking questions is turned off on this server."
        )

    # viewer: asking is reading.
    report = require_access(db, sess.user_id, report_id, need="viewer")
    if not report.view_name:
        raise ApiError(
            "ASK_INVALID",
            400,
            "This report is not bound to a semantic view yet, so there is "
            "nothing to ask about.",
        )

    cache = get_cache()

    def ask(entry):
        detail = cache.describe(
            entry, report.view_database, report.view_schema, report.view_name
        )
        prompt = build_prompt(
            detail,
            question,
            report_filters=(report.definition or {}).get("filters"),
            history=history,
        )
        # One call. No agentic loop, no retry storm.
        reply = provider.complete(entry.conn, prompt)

        # Nothing has touched the database yet. Both of these raise before any
        # query runs, which is what makes a hijacked model harmless.
        spec = parse_spec(reply)
        validate_against_catalog(spec, detail)

        request = _to_query(report, spec)
        sql, params, limit = build_semantic_sql(
            detail, request, max_rows=settings.row_cap
        )
        result = gateway.run_query(entry.conn, sql, max_rows=limit, params=params)
        return spec, sql, result

    spec, sql, result = cache.run(db, sess, ask)

    return {
        "explanation": spec.explanation,
        "spec": spec.model_dump(by_alias=True, mode="json"),
        "columns": result.columns,
        "rows": result.rows,
        "truncated": result.truncated,
        # Returned deliberately: an answer you cannot audit is an answer you
        # should not act on.
        "sql": sql,
    }
