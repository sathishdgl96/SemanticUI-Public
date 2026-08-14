from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.errors import ApiError
from app.semantic.discovery import quote_ident


class OrderBy(BaseModel):
    field: str
    direction: Literal["asc", "desc"] = "asc"


class SemanticQueryRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    database: str
    schema_: str = Field(alias="schema")
    view: str
    dimensions: list[str] = []
    metrics: list[str] = []
    order_by: list[OrderBy] = Field(default_factory=list, alias="orderBy")
    limit: int | None = Field(default=None, ge=1)


def _resolve_fields(detail: dict, refs: list[str], kind: str) -> list[tuple[str, str]]:
    catalog = {
        ((f["table"] or "").upper(), f["name"].upper()): (f["table"], f["name"])
        for f in detail[kind]
    }
    resolved = []
    for ref in refs:
        if "." not in ref:
            raise ApiError("QUERY_ERROR", 400, f"Field reference must be TABLE.NAME: {ref}")
        table, name = ref.split(".", 1)
        hit = catalog.get((table.upper(), name.upper()))
        if hit is None:
            raise ApiError("QUERY_ERROR", 400, f"Unknown {kind[:-1]}: {ref}")
        resolved.append(hit)
    return resolved


def build_semantic_sql(
    detail: dict, req: SemanticQueryRequest, *, max_rows: int
) -> tuple[str, int]:
    dims = _resolve_fields(detail, req.dimensions, "dimensions")
    mets = _resolve_fields(detail, req.metrics, "metrics")
    if not dims and not mets:
        raise ApiError("QUERY_ERROR", 400, "Select at least one dimension or metric")

    parts = [f"{quote_ident(req.database)}.{quote_ident(req.schema_)}.{quote_ident(req.view)}"]
    if dims:
        parts.append(
            "DIMENSIONS " + ", ".join(f"{quote_ident(t)}.{quote_ident(n)}" for t, n in dims)
        )
    if mets:
        parts.append(
            "METRICS " + ", ".join(f"{quote_ident(t)}.{quote_ident(n)}" for t, n in mets)
        )

    selected = dims + mets
    by_bare_name: dict[str, list[tuple[str, str]]] = {}
    for table, name in selected:
        by_bare_name.setdefault(name.upper(), []).append((table, name))
    by_qualified = {
        (table.upper(), name.upper()): (table, name) for table, name in selected
    }

    order_sql = ""
    if req.order_by:
        clauses = []
        for ob in req.order_by:
            if "." in ob.field:
                ref_table, ref_name = ob.field.split(".", 1)
                hit = by_qualified.get((ref_table.upper(), ref_name.upper()))
                if hit is None:
                    raise ApiError(
                        "QUERY_ERROR", 400, f"orderBy field not selected: {ob.field}"
                    )
                canonical = hit[1]
            else:
                matches = by_bare_name.get(ob.field.upper(), [])
                if not matches:
                    raise ApiError(
                        "QUERY_ERROR", 400, f"orderBy field not selected: {ob.field}"
                    )
                if len(matches) > 1:
                    raise ApiError(
                        "QUERY_ERROR",
                        400,
                        f"orderBy field is ambiguous: {ob.field} "
                        "(qualify as TABLE.NAME)",
                    )
                canonical = matches[0][1]
            direction = "DESC" if ob.direction == "desc" else "ASC"
            clauses.append(f"{quote_ident(canonical)} {direction}")
        order_sql = " ORDER BY " + ", ".join(clauses)

    effective_limit = min(req.limit, max_rows) if req.limit else max_rows
    sql = (
        "SELECT * FROM SEMANTIC_VIEW(\n  "
        + "\n  ".join(parts)
        + f"\n){order_sql} LIMIT {effective_limit + 1}"
    )
    return sql, effective_limit
