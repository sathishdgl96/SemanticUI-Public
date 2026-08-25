"""Composite model endpoints.

Every one resolves the composite through the workspace gate before
touching anything, so a stranger cannot read, change or learn the
existence of a model they may not open.

What is recorded is shapes -- how many members, how many shared
dimensions -- and never a view name, a table or a column. A composite's
definition names warehouse objects, and the audit trail is value-free by
contract precisely so it can be shown to an operator in full.
"""

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.audit import record
from app.auth.routes import current_session
from app.composites import service
from app.db.base import get_db
from app.db.models import DbSession
from app.errors import ApiError
from app.reports.filters import FilterList
from app.semantic.query import OrderBy

router = APIRouter()


class CreateBody(BaseModel):
    name: str = Field(default="Untitled model", max_length=200)
    workspaceId: str | None = None


class DefinitionBody(BaseModel):
    definition: dict


class ImportBody(BaseModel):
    definition: dict
    workspaceId: str | None = None


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

    from app.xmla.composite_source import to_model_ref, to_model_refs

    composite = service.get_composite(db, sess.user_id, composite_id)
    definition = parse_definition(composite.definition or {})
    # Callers arrive in two dialects: the model's own (`sales:ORDERS.REVENUE`)
    # and the describe's (`sales.ORDERS.REVENUE`), which is what the report
    # builder builds from a field list. The mapping is idempotent, so one
    # pass serves both and neither caller has to know about the other.
    stitch = plan_composite(
        definition,
        dimensions=to_model_refs(definition, body.dimensions),
        metrics=to_model_refs(definition, body.metrics),
        filters=[
            item.model_copy(update={"field": to_model_ref(definition, item.field)})
            for item in body.filters
        ],
        order_by=[
            item.model_copy(
                update={"field": to_model_ref(definition, item.field)}
            )
            for item in body.orderBy
        ],
        limit=body.limit,
    )

    cache = get_cache()

    def fetch(entry):
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
        result = gateway.run_query(entry.conn, sql, max_rows=effective_limit, params=params)
        return sql, result

    sql, result = cache.run(db, sess, fetch)

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


@router.get("/api/composites/{composite_id}/export")
def export_composite(
    composite_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    """The portable document, byte-stable across two exports of one model.

    A composite is a mapping and nothing else, so exporting one carries
    no data anywhere -- which is what makes it safe to keep in a
    repository beside the views it describes.
    """
    from app.composites.schema import parse_definition, to_export_document

    composite = service.get_composite(db, sess.user_id, composite_id)
    document = to_export_document(parse_definition(composite.definition or {}))
    record(db, "composite.read", user_id=sess.user_id, session_id=sess.id,
           resource_type="composite", resource_id=composite.id,
           detail={"export": True})
    return Response(content=document, media_type="application/json")


@router.post("/api/composites/import", status_code=201)
def import_composite(
    body: ImportBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Create a model from an exported document.

    The document is validated exactly as a save is -- an import is not a
    privileged way in. Member views are NOT resolved here: whether the
    caller can read them is Snowflake's answer, given the first time the
    model is queried, on their own connection.
    """
    composite = service.import_composite(
        db, sess.user_id, body.definition, body.workspaceId
    )
    record(db, "composite.create", user_id=sess.user_id, session_id=sess.id,
           resource_type="composite", resource_id=composite.id,
           detail={"imported": True, **_shape(composite)})
    return service.detail(db, sess.user_id, composite)


@router.get("/api/composites/{composite_id}/describe")
def describe_composite(
    composite_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    """The model's field list, in the shape a semantic view's describe has.

    Same keys, same field shape -- so the report builder, the explorer and
    the field pickers work over a model without knowing it is one. Fields
    are named `<view>.<TABLE>.<FIELD>` for a member's own and
    `<model>.<Name>` for a shared dimension or a derived metric, which is
    exactly what the query endpoint takes back.

    Built from each member's real describe on the caller's own connection,
    so a view they cannot read contributes nothing rather than being
    guessed at.
    """
    from app.composites.schema import parse_definition
    from app.snowflake.provider import get_cache
    from app.xmla.composite_source import member_describes, synthetic_detail

    composite = service.get_composite(db, sess.user_id, composite_id)
    definition = parse_definition(composite.definition or {})

    cache = get_cache()

    def read(entry):
        described, failures = member_describes(
            lambda database, schema, view: cache.describe(
                entry, database, schema, view
            ),
            definition,
        )
        return synthetic_detail(definition, described, failures)

    detail = cache.run(db, sess, read)

    record(db, "composite.read", user_id=sess.user_id, session_id=sess.id,
           resource_type="composite", resource_id=composite.id,
           detail={"describe": True, "fields": len(detail["dimensions"]) + len(detail["metrics"])})
    return {
        **detail,
        "modelHierarchies": [],
        "compositeId": str(composite.id),
        "name": composite.name,
    }


@router.get("/api/composites/{composite_id}/values")
def composite_field_values(
    composite_id: str,
    field: str,
    search: str | None = None,
    limit: int = 10,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    """Distinct values of one of a model's dimensions, for the filter editor.

    Answered by ONE member view, not by the join. Values are what a person
    picks from to build a filter, and a filter on a conformed dimension
    means the same thing in every member -- so asking the whole model
    would pay for a join to learn what one view already knows.

    For a shared dimension that is any member binding it; the values are
    conformed by definition, which is what made it shared. For a member's
    own field it is that member. Either way the query runs on the
    caller's own connection through the same builder every other query
    uses, so `field` is validated against a live DESCRIBE and never
    interpolated.
    """
    from app.composites.schema import parse_definition
    from app.config import get_settings
    from app.semantic.query import SemanticQueryRequest, build_semantic_sql
    from app.semantic.routes import VALUES_CAP
    from app.snowflake import gateway
    from app.snowflake.provider import get_cache
    from app.xmla.composite_source import to_model_ref

    composite = service.get_composite(db, sess.user_id, composite_id)
    definition = parse_definition(composite.definition or {})
    ref = to_model_ref(definition, field)

    # Which member answers, and under what name there.
    members = {m.alias.lower(): m for m in definition.members}
    if ":" in ref:
        alias, rest = ref.split(":", 1)
        member = members.get(alias.lower())
        if member is None:
            raise ApiError("QUERY_ERROR", 400, f"{field} is not a field of this model.")
        target, column = member, rest
    else:
        shared = next(
            (s for s in definition.sharedDimensions if s.name.strip().lower() == ref.strip().lower()),
            None,
        )
        if shared is None:
            # A derived metric has no values to pick from; it is a number
            # computed after the fact, not a column anybody filters on.
            raise ApiError(
                "QUERY_ERROR", 400,
                f"{field} has no values to choose from. Filter on a dimension.",
            )
        alias = next(iter(shared.bindings))
        member = members.get(alias.lower())
        if member is None:
            raise ApiError("QUERY_ERROR", 400, f"{field} is not mapped to a view.")
        binding = shared.bindings[alias]
        target, column = member, f"{binding.table}.{binding.column}"

    page = max(1, min(limit, VALUES_CAP))
    needle = (search or "").strip()
    req = SemanticQueryRequest.model_validate(
        {
            "database": target.database,
            "schema": target.schema_,
            "view": target.view,
            "dimensions": [column],
            "filters": (
                [{"id": "search", "field": column, "op": "contains", "value": needle}]
                if needle
                else []
            ),
            "limit": page + 1,
        }
    )

    cache = get_cache()

    def fetch(entry):
        detail = cache.describe(entry, target.database, target.schema_, target.view)
        sql, params, effective_limit = build_semantic_sql(
            detail, req, max_rows=get_settings().row_cap
        )
        return gateway.run_query(entry.conn, sql, max_rows=effective_limit, params=params)

    result = cache.run(db, sess, fetch)

    seen: set[str] = set()
    for row in result.rows:
        value = row[0] if row else None
        # NULL is dropped: `IN (?)` never matches it, so offering it would
        # build a filter that silently returns nothing.
        if value is None:
            continue
        seen.add(str(value))
    values = sorted(seen)
    return {"values": values[:page], "truncated": len(values) > page}
