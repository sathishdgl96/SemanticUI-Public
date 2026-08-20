"""Composite model endpoints.

Every one resolves the composite through the workspace gate before
touching anything, so a stranger cannot read, change or learn the
existence of a model they may not open.

What is recorded is shapes -- how many members, how many shared
dimensions -- and never a view name, a table or a column. A composite's
definition names warehouse objects, and the audit trail is value-free by
contract precisely so it can be shown to an operator in full.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.audit import record
from app.auth.routes import current_session
from app.composites import service
from app.db.base import get_db
from app.db.models import DbSession
from app.reports.filters import FilterList
from app.semantic.query import OrderBy

router = APIRouter()


class CreateBody(BaseModel):
    name: str = Field(default="Untitled model", max_length=200)
    workspaceId: str | None = None


class DefinitionBody(BaseModel):
    definition: dict


class CompositeQueryBody(BaseModel):
    """A question in the composite's own namespace.

    A bare name in `dimensions` is a shared dimension and a bare name in
    `metrics` is a derived metric; `alias:TABLE.FIELD` anywhere is one
    member's own field. Which list a reference appears in is what
    separates the two namespaces, so nothing has to be guessed.
    """

    dimensions: list[str] = Field(default_factory=list, max_length=64)
    metrics: list[str] = Field(default_factory=list, max_length=64)
    filters: FilterList = Field(default_factory=list)
    orderBy: list[OrderBy] = Field(default_factory=list, max_length=8)
    limit: int | None = Field(default=None, ge=1)


def _shape(composite) -> dict:
    definition = composite.definition or {}
    return {
        "members": len(definition.get("members") or []),
        "sharedDimensions": len(definition.get("sharedDimensions") or []),
        "derivedMetrics": len(definition.get("derivedMetrics") or []),
    }


@router.get("/api/composites")
def list_composites(
    workspace: str | None = None,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    from app.library.search import MAX_ROWS

    rows = service.list_composites(db, sess.user_id, workspace)
    return {"composites": rows[:MAX_ROWS], "truncated": len(rows) > MAX_ROWS}


@router.post("/api/composites", status_code=201)
def create_composite(
    body: CreateBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    composite = service.create_composite(db, sess.user_id, body.name, body.workspaceId)
    record(db, "composite.create", user_id=sess.user_id, session_id=sess.id,
           resource_type="composite", resource_id=composite.id)
    return service.detail(db, sess.user_id, composite)


@router.get("/api/composites/{composite_id}")
def get_composite(
    composite_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    composite = service.get_composite(db, sess.user_id, composite_id)
    record(db, "composite.read", user_id=sess.user_id, session_id=sess.id,
           resource_type="composite", resource_id=composite.id)
    return service.detail(db, sess.user_id, composite)


@router.put("/api/composites/{composite_id}")
def update_composite(
    composite_id: str,
    body: DefinitionBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    composite = service.update_composite(
        db, sess.user_id, composite_id, body.definition
    )
    record(db, "composite.update", user_id=sess.user_id, session_id=sess.id,
           resource_type="composite", resource_id=composite.id,
           detail=_shape(composite))
    return service.detail(db, sess.user_id, composite)


@router.delete("/api/composites/{composite_id}", status_code=204)
def delete_composite(
    composite_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
):
    from fastapi import Response

    service.delete_composite(db, sess.user_id, composite_id)
    record(db, "composite.delete", user_id=sess.user_id, session_id=sess.id,
           resource_type="composite", resource_id=composite_id)
    return Response(status_code=204)


@router.post("/api/composites/{composite_id}/query")
def query_composite(
    composite_id: str,
    body: CompositeQueryBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Ask a composite model a question.

    One statement, on the caller's own connection. Every member view is
    described and queried as *them*, so a model naming a view they may
    not read refuses here in Snowflake's own words -- a composite cannot
    widen anybody's access to the data behind it.
    """
    from app.composites.compile import compile_composite
    from app.composites.planner import plan as plan_composite
    from app.composites.schema import parse_definition
    from app.config import get_settings
    from app.snowflake import gateway
    from app.snowflake.provider import get_cache

    composite = service.get_composite(db, sess.user_id, composite_id)
    definition = parse_definition(composite.definition or {})
    stitch = plan_composite(
        definition,
        dimensions=body.dimensions,
        metrics=body.metrics,
        filters=body.filters,
        order_by=body.orderBy,
        limit=body.limit,
    )

    cache = get_cache()
    entry = cache.acquire(db, sess)
    with entry.lock:
        # Described on this user's connection, so a view they cannot see
        # fails here rather than being planned around.
        describes = {
            branch.alias: cache.describe(
                entry, branch.database, branch.schema, branch.view
            )
            for branch in stitch.branches
        }
        sql, params, effective_limit = compile_composite(
            stitch, describes, max_rows=get_settings().row_cap
        )
        result = gateway.run_query(
            entry.conn, sql, max_rows=effective_limit, params=params
        )

    # Shapes only: how many branches ran, how many rows came back. Never
    # the SQL, the member views, the filters or a value.
    record(
        db,
        "query.run",
        user_id=sess.user_id,
        session_id=sess.id,
        resource_type="composite",
        resource_id=composite.id,
        detail={
            "branches": len(stitch.branches),
            "keys": len(stitch.keys),
            "rows": len(result.rows),
            "truncated": bool(result.truncated),
            "sfqid": result.sfqid,
        },
    )
    return {
        "columns": result.columns,
        "rows": result.rows,
        "truncated": result.truncated,
        "sfqid": result.sfqid,
        "sql": sql,
        # Which views actually ran. A question touching one member costs
        # one branch, and saying so is how that stays visible.
        "branches": [branch.alias for branch in stitch.branches],
    }
