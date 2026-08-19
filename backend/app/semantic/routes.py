"""/api/semantic-views and /api/query/semantic: browse and run.

Every query runs on the caller's own cached connection; there is no
service account anywhere in this codebase.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.config import get_settings
from app.db.base import get_db
from app.db.models import DbSession
from app.semantic import discovery
from app.semantic.query import SemanticQueryRequest, bridged_through, build_semantic_sql
from app.snowflake import gateway
from app.snowflake.provider import get_cache

router = APIRouter()


@router.get("/api/semantic-views")
def list_views(
    database: str | None = None,
    schema: str | None = None,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    entry = get_cache().acquire(db, sess)
    with entry.lock:
        return {"views": discovery.list_semantic_views(entry.conn, database, schema)}


@router.get("/api/semantic-views/{database}/{schema}/{name}")
def describe_view(
    database: str,
    schema: str,
    name: str,
    refresh: bool = False,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    cache = get_cache()
    entry = cache.acquire(db, sess)
    with entry.lock:
        detail = cache.describe(entry, database, schema, name, force=refresh)
    # Model-declared hierarchies, normalised into the same shape a
    # report-defined one has. Empty on every account seen so far, which is why
    # reports can also define their own -- see detect_hierarchies. Built here
    # rather than stored, so the cached describe stays the parser's raw output.
    return {**detail, "modelHierarchies": discovery.detect_hierarchies(detail)}


# The most a caller may ask for in one page. A picker is not a place to read
# a thousand values; `search` is how you reach the ones you want, and this is
# only a backstop against a caller asking for the whole column.
VALUES_CAP = 1000
#: What a picker shows without being asked for more. Ten fits on screen beside
#: the search box that finds the eleventh.
VALUES_PAGE = 10


@router.get("/api/semantic-views/{database}/{schema}/{name}/values")
def field_values(
    database: str,
    schema: str,
    name: str,
    field: str,
    search: str | None = None,
    limit: int = VALUES_PAGE,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Distinct values of one dimension, for the filter editor.

    Runs on the caller's own connection through the same builder every other
    query uses, so `field` is validated against a live DESCRIBE and emitted as
    a quoted identifier -- it is never interpolated from the query string.

    `search` is a case-insensitive substring test, applied INSIDE the semantic
    view so it narrows before the limit does. That distinction is the whole
    point: a column with 150 000 customer names cannot be searched by fetching
    a page and filtering it, because the name you want is almost never in the
    first page.
    """
    cache = get_cache()
    entry = cache.acquire(db, sess)
    page = max(1, min(limit, VALUES_CAP))
    needle = (search or "").strip()
    req = SemanticQueryRequest.model_validate(
        {
            "database": database,
            "schema": schema,
            "view": name,
            "dimensions": [field],
            # Bound like any other filter value -- `search` never becomes SQL
            # text. It is an ordinary `contains`, so it goes through the same
            # validation and the same predicate builder as a saved filter.
            "filters": (
                [{"id": "search", "field": field, "op": "contains", "value": needle}]
                if needle
                else []
            ),
            # One more than the page, so "is there another?" is answered by
            # the rows rather than by a second COUNT query.
            "limit": page + 1,
        }
    )
    with entry.lock:
        detail = cache.describe(entry, database, schema, name)
        sql, params, effective_limit = build_semantic_sql(
            detail, req, max_rows=get_settings().row_cap
        )
        result = gateway.run_query(
            entry.conn, sql, max_rows=effective_limit, params=params
        )

    # A semantic view already groups by its selected dimensions, so the rows
    # come back distinct -- dedupe anyway, since that is a property of the
    # model rather than a guarantee of this endpoint.
    seen: set[str] = set()
    for row in result.rows:
        value = row[0] if row else None
        # NULL is dropped: `IN (?)` never matches it, so offering it would
        # produce a filter that silently returns nothing. An explicit
        # is-blank operator is a later feature.
        if value is None:
            continue
        seen.add(str(value))

    values = sorted(seen)
    # `truncated` now means "there are more that match", which is a prompt to
    # keep typing rather than the old apology for an unusable list.
    return {"values": values[:page], "truncated": len(values) > page}


@router.post("/api/query/semantic")
def query_semantic(
    req: SemanticQueryRequest,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    cache = get_cache()
    entry = cache.acquire(db, sess)
    with entry.lock:
        detail = cache.describe(entry, req.database, req.schema_, req.view)
        sql, params, effective_limit = build_semantic_sql(
            detail, req, max_rows=get_settings().row_cap
        )
        result = gateway.run_query(
            entry.conn, sql, max_rows=effective_limit, params=params
        )
    return {
        "columns": result.columns,
        "rows": result.rows,
        "truncated": result.truncated,
        "sfqid": result.sfqid,
        "sql": sql,
        # Non-null when the selected entities had no join path of their own
        # and the query was routed through a third. The rows are then limited
        # to combinations that occur there, so the UI says which entity.
        "bridgedThrough": bridged_through(detail, req),
    }
