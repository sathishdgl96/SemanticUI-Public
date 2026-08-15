from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.config import get_settings
from app.db.base import get_db
from app.db.models import DbSession
from app.semantic import discovery
from app.semantic.query import SemanticQueryRequest, build_semantic_sql
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
        return cache.describe(entry, database, schema, name, force=refresh)


# A picker listing more than a thousand values is not a picker; past this the
# user needs a search box, which is a later feature. The response says so
# rather than silently showing a prefix.
VALUES_CAP = 1000


@router.get("/api/semantic-views/{database}/{schema}/{name}/values")
def field_values(
    database: str,
    schema: str,
    name: str,
    field: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Distinct values of one dimension, for the filter editor.

    Runs on the caller's own connection through the same builder every other
    query uses, so `field` is validated against a live DESCRIBE and emitted as
    a quoted identifier -- it is never interpolated from the query string.
    """
    cache = get_cache()
    entry = cache.acquire(db, sess)
    req = SemanticQueryRequest.model_validate(
        {
            "database": database,
            "schema": schema,
            "view": name,
            "dimensions": [field],
            "limit": VALUES_CAP + 1,
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
    return {"values": values[:VALUES_CAP], "truncated": len(values) > VALUES_CAP}


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
    }
