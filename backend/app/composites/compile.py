"""The query planner: a stitch plan compiled into one Snowflake statement.

Shape of what comes out:

    WITH "g_sales"   AS (SELECT DISTINCT keys FROM SEMANTIC_VIEW(...filtered)),
         "b_sales"   AS (SELECT ... FROM SEMANTIC_VIEW(...)),
         "b_support" AS (SELECT * FROM (SELECT ... FROM SEMANTIC_VIEW(...))
                         WHERE (keys) IN (SELECT * FROM "g_sales"))
    SELECT COALESCE(...) AS "Customer", ... FROM "b_sales"
      FULL OUTER JOIN "b_support" ON ...
    ORDER BY ... LIMIT n

One statement, one round trip, every branch aggregated by its own view
before anything meets. Two invariants are worth stating because breaking
either produces plausible wrong numbers rather than an error:

**Parameters are positional and assembled in emission order.** Every
fragment appends its SQL and its params in the same pass, so the two
cannot drift apart. A silent off-by-one here binds one filter's value to
another filter's placeholder, and the query still succeeds.

**Nothing but identifiers is interpolated.** Every name goes through
`quote_ident`, which refuses embedded quotes; every value is a `?`.
"""

from typing import Any

from app.composites.planner import BranchPlan, OutputColumn, StitchPlan
from app.composites.schema import split_ref
from app.errors import ApiError
from app.semantic.discovery import quote_ident
from app.semantic.query import build_semantic_sql

#: A branch is an intermediate result, not an answer. It is capped well
#: above any sane grain so a pathological shared dimension cannot pull an
#: unbounded set through the join, and far enough above the outer cap
#: that the cap the user sees is the outer one.
BRANCH_ROW_CAP = 50_000


def display_name(ref: str) -> str:
    """What the result column is called for a field reference.

    A model reference carries the member in front (`sales:ORDERS.REVENUE`);
    the column is named by the part that identifies the field within that
    member (`ORDERS.REVENUE`). A shared dimension or a derived metric has
    no member, so its name stands as it is.

    This is the server half of one agreement: the client resolves a
    reference to a column by taking everything after the first dot, and
    what it gets has to be what is named here.
    """
    return ref.split(":", 1)[-1]


def _key_column(index: int) -> str:
    return quote_ident(f"c{index}")


def _branch_name(alias: str) -> str:
    return quote_ident(f"b_{alias}")


def _gate_name(alias: str) -> str:
    return quote_ident(f"g_{alias}")


def _resolve_metric(plan: StitchPlan, ref: str) -> tuple[str, int]:
    """`sales:ORDERS.REVENUE` -> (branch alias, projected position)."""
    alias, rest = split_ref(ref)
    for branch in plan.branches:
        if branch.alias == alias.lower():
            if rest not in branch.request.metrics:
                break
            return branch.alias, len(branch.request.dimensions) + branch.request.metrics.index(rest)
    raise ApiError(
        "QUERY_ERROR", 400, f"{ref} is not available in this question."
    )


def _expr_sql(plan: StitchPlan, node: Any, null_if_zero: bool) -> str:
    """A derived metric's expression, over already-aggregated columns."""
    metric = getattr(node, "metric", None)
    if metric is not None:
        alias, position = _resolve_metric(plan, metric)
        return f"{_branch_name(alias)}.{_key_column(position)}"
    if getattr(node, "op", None) is None:
        # A bare number. `float()` of a value pydantic already validated
        # as one, so what reaches SQL is a literal this code produced --
        # not a string that came from outside.
        return repr(float(node.value))
    left = _expr_sql(plan, node.left, null_if_zero)
    right = _expr_sql(plan, node.right, null_if_zero)
    if node.op == "/" and null_if_zero:
        # No tickets makes revenue-per-ticket undefined, not infinite and
        # not an error that fails the whole query for one row.
        return f"CASE WHEN {right} = 0 THEN NULL ELSE {left} / {right} END"
    return f"({left} {node.op} {right})"


def _branch_sql(
    branch: BranchPlan, detail: dict, *, today=None
) -> tuple[str, list[Any]]:
    sql, params, _ = build_semantic_sql(
        detail, branch.request, max_rows=BRANCH_ROW_CAP, today=today, as_branch=True
    )
    return sql, params


def _gate_sql(
    branch: BranchPlan, detail: dict, key_count: int, *, today=None
) -> tuple[str, list[Any]]:
    """The keys that survive this branch's own filters.

    Its own CTE rather than a reference to the branch, because with two
    locally filtered branches each would have to narrow the other and the
    CTEs would be circular. A gate depends on nothing.
    """
    request = branch.request.model_copy(
        update={
            "dimensions": branch.request.dimensions[:key_count],
            "metrics": [],
            "aggregations": [],
        }
    )
    sql, params, _ = build_semantic_sql(
        detail, request, max_rows=BRANCH_ROW_CAP, today=today, as_branch=True
    )
    keys = ", ".join(_key_column(i) for i in range(key_count))
    return f"SELECT DISTINCT {keys} FROM ({sql})", params


def compile_composite(
    plan: StitchPlan,
    describes: dict[str, dict],
    *,
    max_rows: int,
    today=None,
) -> tuple[str, list[Any], int]:
    """Return (sql, params, effective_limit) for a whole composite question.

    `describes` maps a branch alias to that member view's DESCRIBE, which
    the caller has already fetched on the user's own connection.
    """
    key_count = len(plan.keys)
    parts: list[str] = []
    params: list[Any] = []

    # Gates first: a branch may reference one, so it must already exist.
    gated = [
        b
        for b in plan.branches
        if b.locally_filtered and plan.cross_filter == "semi" and len(plan.branches) > 1
    ]
    for branch in gated:
        if not key_count:
            continue
        sql, gate_params = _gate_sql(
            branch, describes[branch.alias], key_count, today=today
        )
        parts.append(f"{_gate_name(branch.alias)} AS (\n{sql}\n)")
        params.extend(gate_params)

    for branch in plan.branches:
        sql, branch_params = _branch_sql(branch, describes[branch.alias], today=today)
        params.extend(branch_params)
        # Every gate but this branch's own narrows it: "the rows for the
        # keys the other filters left".
        others = [g for g in gated if g.alias != branch.alias]
        if others and key_count:
            keys = ", ".join(_key_column(i) for i in range(key_count))
            predicate = " AND ".join(
                f"({keys}) IN (SELECT {keys} FROM {_gate_name(g.alias)})"
                for g in others
            )
            sql = f"SELECT * FROM (\n{sql}\n) WHERE {predicate}"
        parts.append(f"{_branch_name(branch.alias)} AS (\n{sql}\n)")

    # --- the join ------------------------------------------------------
    join_word = "FULL OUTER JOIN" if plan.join_type == "full" else "INNER JOIN"
    first = plan.branches[0]
    from_sql = _branch_name(first.alias)
    carried: list[str] = [first.alias]
    for branch in plan.branches[1:]:
        conditions = []
        for index in range(key_count):
            left = _coalesced(carried, index)
            conditions.append(
                f"{left} = {_branch_name(branch.alias)}.{_key_column(index)}"
            )
        on_sql = " AND ".join(conditions) if conditions else "TRUE"
        from_sql += f"\n{join_word} {_branch_name(branch.alias)}\n  ON {on_sql}"
        carried.append(branch.alias)

    # --- the projection -------------------------------------------------
    projected = [_column_sql(plan, column) for column in plan.columns]

    # Two fields whose display names collide would answer under one
    # heading, and a chart resolving that name would draw whichever came
    # first. Refused by name rather than left to look like bad data.
    shown: dict[str, str] = {}
    for column in plan.columns:
        label = display_name(column.name)
        if label in shown and shown[label] != column.name:
            raise ApiError(
                "QUERY_ERROR",
                400,
                f"{shown[label]} and {column.name} would both be called "
                f"{label!r} in the answer. Ask for one of them, or rename "
                "one in its view.",
            )
        shown[label] = column.name

    order_sql = ""
    if plan.order_by:
        names = {column.name for column in plan.columns}
        clauses = []
        for item in plan.order_by:
            if item.field not in names:
                raise ApiError(
                    "QUERY_ERROR", 400, f"orderBy field not selected: {item.field}"
                )
            direction = "DESC" if item.direction == "desc" else "ASC"
            clauses.append(f"{quote_ident(display_name(item.field))} {direction}")
        order_sql = " ORDER BY " + ", ".join(clauses)

    effective_limit = min(plan.limit, max_rows) if plan.limit else max_rows
    sql = (
        "WITH "
        + ",\n".join(parts)
        + "\nSELECT "
        + ", ".join(projected)
        + f"\nFROM {from_sql}"
        + f"{order_sql} LIMIT {effective_limit + 1}"
    )
    return sql, params, effective_limit


def _coalesced(aliases: list[str], index: int) -> str:
    """The key as it stands after joining `aliases`.

    With a full outer join the left side's key is NULL for a row only the
    right side has, so the next join has to compare against whichever of
    the earlier branches actually carries it.
    """
    columns = [f"{_branch_name(a)}.{_key_column(index)}" for a in aliases]
    if len(columns) == 1:
        return columns[0]
    return "COALESCE(" + ", ".join(columns) + ")"


def _column_sql(plan: StitchPlan, column: OutputColumn) -> str:
    name = quote_ident(display_name(column.name))
    if column.kind == "key":
        aliases = [alias for alias, _ in column.sources]
        index = column.sources[0][1]
        return f"{_coalesced(aliases, index)} AS {name}"
    if column.kind == "derived":
        return (
            f"{_expr_sql(plan, column.expr, column.null_if_zero_denominator)} AS {name}"
        )
    alias, position = column.sources[0]
    return f"{_branch_name(alias)}.{_key_column(position)} AS {name}"
