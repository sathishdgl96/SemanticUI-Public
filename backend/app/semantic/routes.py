"""/api/semantic-views and /api/query/semantic: browse and run.

Every query runs on the caller's own cached connection; there is no
service account anywhere in this codebase.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.config import get_settings
from app.db.base import get_db
from app.db.models import DbSession, User
from app.errors import ApiError
from app.semantic import certification, discovery
from app.semantic.query import SemanticQueryRequest, bridged_through, build_semantic_sql
from app.snowflake import gateway
from app.snowflake.provider import get_cache
from app.audit import record

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
        views = discovery.list_semantic_views(entry.conn, database, schema)
    # One query for the whole page, not one per row: the badge must not cost
    # a round trip per view.
    certified = certification.certified_keys(db)
    for view in views:
        view["certified"] = (
            view["database"], view["schema"], view["name"]
        ) in certified
    return {"views": views}


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
    # The single most valuable line in a data tool's trail: somebody asked
    # this view a question. Shapes only -- how many rows came back and
    # whether it was capped, never the SQL, the filters or a value. The
    # Snowflake query id is here because it is what joins this row to
    # Snowflake's own QUERY_HISTORY.
    record(
        db,
        "query.run",
        user_id=sess.user_id,
        session_id=sess.id,
        resource_type="semantic_view",
        resource_id=f"{req.database}.{req.schema_}.{req.view}"[:64],
        detail={
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
        # Non-null when the selected entities had no join path of their own
        # and the query was routed through a third. The rows are then limited
        # to combinations that occur there, so the UI says which entity.
        "bridgedThrough": bridged_through(detail, req),
    }


# --- Certification ---------------------------------------------------------
# Who may certify a semantic view is Snowflake's answer, never the app's. The
# owning role comes from SHOW SEMANTIC VIEWS and the caller's own connection is
# asked whether their session holds it. Every path that cannot establish that
# refuses: a trust control that fails open produces a badge nobody checked.


class CertificationBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    certified: bool
    ownerName: str | None = Field(default=None, max_length=255)
    ownerContact: str | None = Field(default=None, max_length=255)
    note: str | None = Field(default=None, max_length=1000)


def _owner_of(conn, database: str, schema: str, name: str) -> tuple:
    """The owning role and its kind, or (None, None) if unreadable."""
    for view in discovery.list_semantic_views(conn, database, schema):
        if view.get("name") == name:
            return view.get("owner"), view.get("ownerRoleType")
    return None, None


def _certification_body(row, *, can_certify: bool) -> dict:
    return {
        "certified": bool(row and row.certified),
        "owner": {
            "name": row.owner_name if row else None,
            "contact": row.owner_contact if row else None,
        },
        "certifiedBy": (
            {"role": row.certified_by_role, "at": row.certified_at}
            if row and row.certified
            else None
        ),
        "note": row.note if row else None,
        "canCertify": can_certify,
    }


@router.get("/api/semantic-views/{database}/{schema}/{name}/certification")
def read_certification(
    database: str,
    schema: str,
    name: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    entry = get_cache().acquire(db, sess)
    with entry.lock:
        owner, kind = _owner_of(entry.conn, database, schema, name)
        # One round trip, and only here -- never per row of a listing.
        can = certification.may_certify(entry.conn, owner, kind)
    row = certification.get(db, database, schema, name)
    return _certification_body(row, can_certify=can)


@router.put("/api/semantic-views/{database}/{schema}/{name}/certification")
def write_certification(
    database: str,
    schema: str,
    name: str,
    body: CertificationBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    entry = get_cache().acquire(db, sess)
    with entry.lock:
        owner, kind = _owner_of(entry.conn, database, schema, name)
        if not certification.may_certify(entry.conn, owner, kind):
            record(db, "model.certify", user_id=sess.user_id, session_id=sess.id,
                   resource_type="semantic_view", outcome="denied",
                   detail={"reason": "not the owning role"})
            raise ApiError(
                "FORBIDDEN", 403,
                "Certifying this model needs the Snowflake role that owns it.",
            )

    user = db.get(User, sess.user_id)
    row = certification.put(
        db, database, schema, name, user=user, role=owner,
        certified=body.certified, owner_name=body.ownerName,
        owner_contact=body.ownerContact, note=body.note,
    )
    # Two actions rather than one with a flag: "who certified this" and "who
    # withdrew it" are different questions to ask the trail later.
    record(db, "model.certify" if body.certified else "model.uncertify",
           user_id=sess.user_id, session_id=sess.id,
           resource_type="semantic_view", detail={"role": owner})
    return _certification_body(row, can_certify=True)
