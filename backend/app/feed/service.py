"""One visual's numbers as a flat result set, for Power Query's From Web.

This is the zero-install Excel path. No ODBC driver, no add-in, no admin:
stock Excel's Data -> From Web against these URLs, refreshed on demand, each
refresh a fresh query run on the CALLER'S own Snowflake connection. It exists
because every other live-Excel route turned out to need something a
locked-down machine cannot get -- a driver install, an admin, or an
undocumented Microsoft handshake.

Two rules carried over unchanged from the rest of the product:

* Every query runs on the caller's own connection. The connect token in
  HTTP Basic resolves to the caller's APP SESSION, and the query runs on
  that session's cached Snowflake connection -- the feed never opens one.
* The workspace decides visibility. The token proves which app user is
  asking; the report is only served if `require_access` says that user may
  open it in the app.

The query is built from the STORED definition -- the same wells, the same
three filter scopes -- so the feed shows what the report shows. A hierarchy
on an axis serves its top level, exactly as a freshly opened report does.
"""

import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import Report
from app.errors import ApiError
from app.reports.catalog import HIERARCHY_PREFIX, wells_to_query
from app.reports.filters import is_active
from app.reports.migrate import migrate_definition
from app.semantic.predicates import resolve_field
from app.semantic.query import SemanticQueryRequest, build_semantic_sql
from app.snowflake import gateway
from app.snowflake.provider import get_cache
from app.workspaces.access import require_access


def _visual_and_page(definition: dict, visual_id: str) -> tuple[dict, dict]:
    for page in definition.get("pages", []):
        for visual in page.get("visuals", []):
            if visual.get("id") == visual_id:
                return visual, page
    raise ApiError("HTTP_ERROR", 404, f"No visual {visual_id!r} on this report")


def _top_level(ref: str, hierarchies: list[dict]) -> str:
    """A hierarchy well entry resolves to its first level, like a fresh open."""
    if not ref.startswith(HIERARCHY_PREFIX):
        return ref
    wanted = ref[len(HIERARCHY_PREFIX):]
    for hierarchy in hierarchies:
        if hierarchy.get("id") == wanted and hierarchy.get("levels"):
            return hierarchy["levels"][0]
    raise ApiError(
        "HTTP_ERROR", 404, f"The hierarchy {wanted!r} is not defined on this report"
    )


def build_feed_request(
    report: Report,
    visual_id: str,
    *,
    extra_filters: dict[str, str],
    limit: int | None,
    detail: dict,
) -> SemanticQueryRequest:
    definition = migrate_definition(report.definition or {})
    visual, page = _visual_and_page(definition, visual_id)
    hierarchies = definition.get("hierarchies", [])

    wells = {
        key: [_top_level(ref, hierarchies) for ref in refs]
        for key, refs in (visual.get("wells") or {}).items()
    }
    dimensions, metrics = wells_to_query(visual.get("type", "table"), wells)

    # All three scopes, composed by intersection -- the same rule the canvas
    # applies. Unfinished filters are skipped, not errors.
    filters = [
        f
        for scope in (
            definition.get("filters", []),
            page.get("filters", []),
            visual.get("filters", []),
        )
        for f in scope
    ]

    # ?f.TABLE.FIELD=value narrows further -- this is how a worksheet cell
    # drives the slice at any data volume. Validated against the live
    # DESCRIBE like every other field reference; the VALUE is bound, never
    # SQL text.
    for index, (field, value) in enumerate(sorted(extra_filters.items())):
        resolve_field(detail, field)
        filters.append(
            {"id": f"feed{index}", "field": field, "op": "is", "values": [value]}
        )

    options = visual.get("options") or {}
    order_by = []
    sort = options.get("sort")
    if isinstance(sort, dict) and sort.get("field"):
        order_by.append(
            {"field": sort["field"], "direction": sort.get("direction", "desc")}
        )

    aggregations = []
    for ref, fn in (options.get("aggregations") or {}).items():
        if ref in metrics:
            metrics.remove(ref)
            aggregations.append({"field": ref, "fn": fn})

    top_n = options.get("topN")
    effective_limit = limit
    if isinstance(top_n, int) and top_n > 0:
        effective_limit = min(limit, top_n) if limit else top_n

    return SemanticQueryRequest.model_validate(
        {
            "database": report.view_database,
            "schema": report.view_schema,
            "view": report.view_name,
            "dimensions": dimensions,
            "metrics": metrics,
            "aggregations": aggregations,
            "filters": [f for f in filters],
            "orderBy": order_by,
            "limit": effective_limit,
        }
    )


def run_feed(
    db: Session,
    user_id: uuid.UUID,
    entry: Any,
    report_id: str,
    visual_id: str,
    *,
    extra_filters: dict[str, str],
    limit: int | None,
) -> tuple[list[str], list[list], bool]:
    """(column names, rows, truncated) for one visual, on the caller's own
    app-session connection (`entry` is that session's cache entry)."""
    report = require_access(db, user_id, report_id, need="viewer")
    if not report.view_name:
        raise ApiError(
            "HTTP_ERROR", 404, "This report is not bound to a semantic view yet."
        )

    with entry.lock:
        detail = get_cache().describe(
            entry, report.view_database, report.view_schema, report.view_name
        )
        request = build_feed_request(
            report, visual_id, extra_filters=extra_filters, limit=limit, detail=detail
        )
        # Active-only, after validation: the stored document may hold
        # unfinished filters, which mean "not filtering yet".
        request.filters = [f for f in request.filters if is_active(f)]
        sql, params, effective_limit = build_semantic_sql(
            detail, request, max_rows=get_settings().export_row_cap
        )
        result = gateway.run_query(
            entry.conn, sql, max_rows=effective_limit, params=params
        )

    return [c["name"] for c in result.columns], result.rows, result.truncated
