from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.errors import ApiError
from app.reports.filters import FilterList
from app.semantic.discovery import quote_ident
from app.semantic.joins import plan_join
from app.semantic.predicates import build_filter_predicates


class OrderBy(BaseModel):
    field: str
    direction: Literal["asc", "desc"] = "asc"


#: SQL for each aggregation function. A fixed map, not a format string built
#: from the request: the function name is never taken from user input.
AGGREGATE_SQL: dict[str, str] = {
    "sum": "SUM({col})",
    "avg": "AVG({col})",
    "min": "MIN({col})",
    "max": "MAX({col})",
    "count": "COUNT({col})",
    "countDistinct": "COUNT(DISTINCT {col})",
}


class Aggregation(BaseModel):
    """An aggregation applied to a raw FACT column.

    This is PowerBI's habit -- drop any numeric field into Values and pick
    Sum/Average/Count -- expressed over a semantic view. The view's own
    METRICS stay first-class and are still the governed way to measure;
    this is the escape hatch for a question the model does not answer yet.
    """

    field: str
    fn: Literal["sum", "avg", "min", "max", "count", "countDistinct"]


class SemanticQueryRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    database: str
    schema_: str = Field(alias="schema")
    view: str
    dimensions: list[str] = []
    metrics: list[str] = []
    #: Ad-hoc aggregations over FACT columns. Mutually exclusive with
    #: `metrics` -- see build_semantic_sql for why.
    aggregations: list[Aggregation] = Field(default_factory=list)
    #: The effective, already-composed filter set for this query: report
    #: filters AND the visual's own AND any active cross-filter. The client
    #: composes them; the server validates and binds every one.
    filters: FilterList = Field(default_factory=list)
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


def _listed(refs: list[str]) -> str:
    """"A", "B" and "C" -- for a sentence, not a clause."""
    if len(refs) == 1:
        return refs[0]
    return f"{', '.join(refs[:-1])} and {refs[-1]}"


def _plan_and_repair_join(
    detail: dict, dims: list[tuple[str, str]], mets: list[tuple[str, str]]
) -> tuple[str, str] | None:
    """Return a bridging metric to add, or raise with an actionable message.

    Snowflake roots a SEMANTIC_VIEW query at a base entity and rejects
    anything it cannot reach, with an error that names entities rather than
    fields ("The dimension entity 'ORDERS' has a higher level of granularity
    than the base metric entity 'CUSTOMERS'"). Reaching that error means the
    user has already waited for a round trip to be told, in the model's
    vocabulary rather than their own, that the two things they picked do not
    go together. Both outcomes here are better than that: repair it silently
    where the graph allows, and where it does not, say which field to drop
    and what to measure instead.
    """
    plan = plan_join(
        detail, {t.upper() for t, _ in dims}, {t.upper() for t, _ in mets}
    )
    if plan.bridge:
        selected = {name.upper() for _, name in dims}
        for metric in detail.get("metrics") or []:
            if (metric.get("table") or "").upper() != plan.bridge:
                continue
            # A bridge whose bare name collides with a selected field would
            # take that field out of the projection along with itself, since
            # EXCLUDE matches output names and those are bare.
            if metric["name"].upper() not in selected:
                return (metric["table"], metric["name"])
        plan = plan.__class__(blocked=tuple(sorted({t.upper() for t, _ in dims})))

    if not plan.blocked:
        return None

    blocked_fields = [f"{t}.{n}" for t, n in dims if t.upper() in plan.blocked]
    if plan.base:
        base_metrics = [f"{t}.{n}" for t, n in mets if t.upper() == plan.base]
        advice = (
            f" Measure it with {_listed(list(plan.alternatives[:3]))} instead, "
            f"or remove {blocked_fields[0]}."
            if plan.alternatives
            else f" Remove {blocked_fields[0]}, or group by a field from {plan.base}."
        )
        raise ApiError(
            "QUERY_ERROR",
            400,
            f"{_listed(base_metrics)} is measured per {plan.base}, so it cannot be "
            f"broken down by {_listed(blocked_fields)}.{advice}",
        )
    raise ApiError(
        "QUERY_ERROR",
        400,
        f"{_listed(blocked_fields)} belong to entities this view does not connect, "
        "and it has no measure on an entity that would join them. Drop one of "
        "them, or pick fields that share a table.",
    )


def bridged_through(detail: dict, req: SemanticQueryRequest) -> str | None:
    """The entity a query had to be routed through, if any.

    Read by the query route so the answer can say so. Joining two unrelated
    entities through a third narrows the result to combinations that actually
    occur there, which is the only answer the model can give -- but it is a
    real change in meaning, and one the user did not ask for. Disclosing it
    costs a line of UI; not disclosing it costs someone's trust in a number.
    """
    try:
        dims = _resolve_fields(detail, req.dimensions, "dimensions")
        mets = _resolve_fields(detail, req.metrics, "metrics")
    except ApiError:
        return None
    plan = plan_join(detail, {t.upper() for t, _ in dims}, {t.upper() for t, _ in mets})
    return plan.bridge


def build_semantic_sql(
    detail: dict, req: SemanticQueryRequest, *, max_rows: int, today: date | None = None
) -> tuple[str, list[Any], int]:
    """Return (sql, params, effective_limit).

    `params` is positional and must be handed to the cursor as-is: it holds
    every filter VALUE, none of which appears anywhere in `sql`.
    """
    dims = _resolve_fields(detail, req.dimensions, "dimensions")
    mets = _resolve_fields(detail, req.metrics, "metrics")
    facts = _resolve_fields(detail, [a.field for a in req.aggregations], "facts")

    if mets and req.aggregations:
        # A metric is already aggregated by the semantic model; a fact is
        # row-level. Selecting both puts two granularities in one result set,
        # where the metric would be silently repeated down every raw row --
        # a wrong number that looks like a right one.
        raise ApiError(
            "QUERY_ERROR",
            400,
            "A visual can use the view's own metrics or its own aggregations "
            "over raw fields, but not both at once: they are measured at "
            "different grains.",
        )
    if not dims and not mets and not facts:
        raise ApiError("QUERY_ERROR", 400, "Select at least one dimension or metric")

    if facts and dims:
        # Snowflake's own rule, found by running it: "All expressions
        # referenced in the query must come from the same entity when both
        # FACTS and DIMENSIONS are specified." A raw fact has no join path of
        # its own -- only the model's METRICS carry one -- so it can only be
        # grouped by dimensions of its own table.
        #
        # Checked here so the user gets a sentence that says what to do,
        # rather than Snowflake's, which does not name the offending fields.
        entities = {table.upper() for table, _ in facts} | {
            table.upper() for table, _ in dims
        }
        if len(entities) > 1:
            fact_tables = sorted({table for table, _ in facts})
            raise ApiError(
                "QUERY_ERROR",
                400,
                "A raw field can only be summarised by fields from its own "
                f"table ({', '.join(fact_tables)}). Group by a field from "
                "that table, or use one of the view's own metrics, which "
                "carry the joins this does not.",
            )

    bridge_metric = _plan_and_repair_join(detail, dims, mets)

    parts = [f"{quote_ident(req.database)}.{quote_ident(req.schema_)}.{quote_ident(req.view)}"]
    if dims:
        parts.append(
            "DIMENSIONS " + ", ".join(f"{quote_ident(t)}.{quote_ident(n)}" for t, n in dims)
        )
    if mets or bridge_metric:
        clause = [f"{quote_ident(t)}.{quote_ident(n)}" for t, n in mets]
        if bridge_metric:
            clause.append(f"{quote_ident(bridge_metric[0])}.{quote_ident(bridge_metric[1])}")
        parts.append("METRICS " + ", ".join(clause))
    if facts:
        # FACTS is its own clause -- verified against a real account. Facts
        # come back row-level here; the outer SELECT below is what aggregates
        # them.
        parts.append(
            "FACTS " + ", ".join(f"{quote_ident(t)}.{quote_ident(n)}" for t, n in facts)
        )

    # Inside SEMANTIC_VIEW(...), after METRICS and before the closing paren --
    # not after the call. The predicate has to apply before aggregation, or a
    # KPI card filtered by region would have no REGION column left to filter
    # on. Verified against a real account; see
    # docs/superpowers/specs/2026-08-15-filter-spike-findings.md.
    predicates, params = build_filter_predicates(detail, req.filters, today=today)
    if predicates:
        parts.append("WHERE " + " AND ".join(predicates))

    selected = dims + mets + facts
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

    # The projection. Without aggregations this stays "SELECT *", byte for
    # byte what it always was -- an aggregation-free query must not change
    # shape just because the feature exists.
    if req.aggregations:
        projected = [quote_ident(name) for _, name in dims]
        for aggregation, (_, name) in zip(req.aggregations, facts):
            template = AGGREGATE_SQL[aggregation.fn]
            #: Aliased back to the field's own bare name, so a caller reads
            #: the column exactly as it reads any other field's -- and every
            #: renderer keeps working without knowing an aggregation happened.
            projected.append(
                f"{template.format(col=quote_ident(name))} AS {quote_ident(name)}"
            )
        select_sql = ", ".join(projected)
        group_sql = (
            " GROUP BY " + ", ".join(quote_ident(name) for _, name in dims) if dims else ""
        )
    elif bridge_metric:
        # The bridge exists to make the join legal, not to be read. EXCLUDE
        # rather than an explicit column list so the shape stays "everything
        # you asked for, in the order you asked for it" -- an explicit list
        # would have to name columns whose bare names can repeat across
        # entities.
        select_sql = f"* EXCLUDE ({quote_ident(bridge_metric[1])})"
        group_sql = ""
    else:
        select_sql = "*"
        group_sql = ""

    sql = (
        f"SELECT {select_sql} FROM SEMANTIC_VIEW(\n  "
        + "\n  ".join(parts)
        + f"\n){group_sql}{order_sql} LIMIT {effective_limit + 1}"
    )
    return sql, params, effective_limit
