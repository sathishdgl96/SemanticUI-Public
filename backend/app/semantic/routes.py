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
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    entry = get_cache().acquire(db, sess)
    with entry.lock:
        return discovery.describe_semantic_view(entry.conn, database, schema, name)


@router.post("/api/query/semantic")
def query_semantic(
    req: SemanticQueryRequest,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    entry = get_cache().acquire(db, sess)
    with entry.lock:
        detail = discovery.describe_semantic_view(
            entry.conn, req.database, req.schema_, req.view
        )
        sql, effective_limit = build_semantic_sql(
            detail, req, max_rows=get_settings().row_cap
        )
        result = gateway.run_query(entry.conn, sql, max_rows=effective_limit)
    return {
        "columns": result.columns,
        "rows": result.rows,
        "truncated": result.truncated,
        "sfqid": result.sfqid,
        "sql": sql,
    }
