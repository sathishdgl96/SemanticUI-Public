"""The semantic planner: a composite question, routed to its members.

Input is a question in the *composite* namespace. Output is one plan per
member view that actually has to answer something, each holding a plain
`SemanticQueryRequest` in that view's own namespace -- so every branch
compiles through the existing single-view builder, unchanged.

This module is a pure function of (definition, request). It performs no
I/O and knows nothing about connections, which is what makes the rules
below testable exhaustively rather than by observation.

Three ideas carry it:

**Routing.** A metric belongs to exactly one member; naming it decides
which branch runs. A member nobody asked anything of contributes no
branch at all, so a composite question that happens to touch one view
compiles to exactly the query that view would have got on its own.

**Conformed dimensions are the only join.** Branches meet on the shared
dimensions that were actually selected -- never on a column two views
happen to spell the same way.

**Aggregate first, then join.** Every branch aggregates at the selected
grain inside its own view before anything is joined. That is what makes
fan and chasm traps impossible here rather than merely unlikely: there
is no code path in which raw rows from two views meet.
"""

from dataclasses import dataclass, field

from app.composites.schema import CompositeDefinition, split_ref
from app.errors import ApiError
from app.semantic.query import OrderBy, SemanticQueryRequest


@dataclass
class BranchPlan:
    """One member view's share of the question."""

    alias: str
    database: str
    schema: str
    view: str
    request: SemanticQueryRequest
    #: Position in `request.dimensions` of each selected shared dimension,
    #: in the composite's canonical order. These are the join keys, and
    #: the branch projects them as c0, c1, ... in that same order.
    key_positions: list[int] = field(default_factory=list)
    #: True when a filter on this member's OWN field narrowed it, which is
    #: what makes it a gate the other branches may be narrowed by.
    locally_filtered: bool = False


@dataclass
class StitchPlan:
    """How the branches meet, and what the answer is called."""

    branches: list[BranchPlan]
    #: Shared dimension names actually selected, in request order.
    keys: list[str]
    join_type: str
    cross_filter: str
    #: Output column name -> how to compute it. Resolved by the compiler.
    columns: list["OutputColumn"]
    order_by: list[OrderBy]
    limit: int | None


@dataclass
class OutputColumn:
    """One column of the answer, named as the caller asked for it."""

    name: str
    #: "key" -> COALESCE across branches; "field" -> one branch's column;
    #: "derived" -> arithmetic over other columns.
    kind: str
    #: For "key": the branches carrying it. For "field": (alias, index).
    sources: list[tuple[str, int]] = field(default_factory=list)
    #: For "derived": the expression tree, with metric refs already
    #: resolved to (alias, index) pairs by the planner.
    expr: object | None = None
    null_if_zero_denominator: bool = True


def _members_by_alias(definition: CompositeDefinition) -> dict[str, object]:
    return {member.alias.lower(): member for member in definition.members}


def _shared_by_name(definition: CompositeDefinition) -> dict[str, object]:
    return {shared.name.strip().lower(): shared for shared in definition.sharedDimensions}


def _derived_by_name(definition: CompositeDefinition) -> dict[str, object]:
    return {metric.name.strip().lower(): metric for metric in definition.derivedMetrics}


def _error(message: str) -> ApiError:
    return ApiError("QUERY_ERROR", 400, message)


def _require_member(definition: CompositeDefinition, alias: str, ref: str):
    member = _members_by_alias(definition).get(alias.lower())
    if member is None:
        raise _error(
            f"{ref} names {alias!r}, which is not a view in this model."
        )
    return member


def plan(
    definition: CompositeDefinition,
    *,
    dimensions: list[str],
    metrics: list[str],
    filters: list | None = None,
    order_by: list[OrderBy] | None = None,
    limit: int | None = None,
) -> StitchPlan:
    """Route a composite question to its members.

    Naming rules, and they are the whole API surface:

    * a **bare name** in `dimensions` is a shared dimension;
    * a **bare name** in `metrics` is a derived metric;
    * `alias:TABLE.FIELD` anywhere is that member's own field.

    Unqualified never means "guess which view" -- the two namespaces are
    separated by which list a reference appears in, so nothing is
    ambiguous and nothing has to be inferred.
    """
    shared_map = _shared_by_name(definition)
    derived_map = _derived_by_name(definition)
    filters = list(filters or [])

    # alias -> what this member has been asked for in its own right.
    # A shared dimension is deliberately NOT enough to put a member here:
    # asking for revenue by customer must not also query the support view
    # merely because it happens to know what a customer is.
    active: dict[str, dict[str, list]] = {}

    def branch(alias: str) -> dict[str, list]:
        return active.setdefault(
            alias.lower(),
            {"local_dims": [], "metrics": [], "filters": [], "locally_filtered": False},
        )

    selected_keys: list[str] = []
    columns: list[OutputColumn] = []

    # --- pass 1: what each member was asked for directly --------------
    for ref in dimensions:
        if ":" not in ref:
            shared = shared_map.get(ref.strip().lower())
            if shared is None:
                raise _error(
                    f"{ref!r} is not a shared dimension of this model. Write a "
                    "view's own field as alias:TABLE.FIELD."
                )
            if ref not in selected_keys:
                selected_keys.append(ref)
            continue
        alias, rest = split_ref(ref)
        _require_member(definition, alias, ref)
        branch(alias)["local_dims"].append(rest)
        columns.append(OutputColumn(name=ref, kind="field", sources=[(alias.lower(), -1)]))

    for ref in metrics:
        if ":" in ref:
            alias, rest = split_ref(ref)
            _require_member(definition, alias, ref)
            if rest not in branch(alias)["metrics"]:
                branch(alias)["metrics"].append(rest)
            columns.append(OutputColumn(name=ref, kind="field", sources=[(alias.lower(), -1)]))
            continue
        derived = derived_map.get(ref.strip().lower())
        if derived is None:
            raise _error(
                f"{ref!r} is not a metric of this model. Write a view's own "
                "metric as alias:TABLE.METRIC."
            )
        # Every metric the expression names has to be fetched, whether or
        # not the caller also asked for it in its own right.
        for inner in _refs_of(derived.expr):
            alias, rest = split_ref(inner)
            _require_member(definition, alias, inner)
            if rest not in branch(alias)["metrics"]:
                branch(alias)["metrics"].append(rest)
        columns.append(
            OutputColumn(
                name=ref,
                kind="derived",
                expr=derived.expr,
                null_if_zero_denominator=derived.nullIfDenominatorZero,
            )
        )

    for item in filters:
        ref = getattr(item, "field", "")
        if ":" not in ref:
            continue  # shared filters are applied in pass 3
        alias, rest = split_ref(ref)
        _require_member(definition, alias, ref)
        branch(alias)["filters"].append(item.model_copy(update={"field": rest}))
        branch(alias)["locally_filtered"] = True

    # --- pass 2: a question of shared dimensions alone ----------------
    # "Which customers exist?" names no metric and no member. Every view
    # that knows the concept answers, and the outer join unions them.
    if not active and selected_keys:
        for key in selected_keys:
            for alias in shared_map[key.strip().lower()].bindings:
                branch(alias)

    if not active:
        raise _error("Select at least one field from this model.")

    # --- the rule that makes the answer joinable ----------------------
    if len(active) >= 2 and not selected_keys:
        raise _error(
            f"This question spans {len(active)} views but selects no shared "
            "dimension. Add one -- it is the column that tells the views' "
            "answers apart."
        )

    # --- pass 3: assemble each branch's request -----------------------
    # Keys first and in the model's order, so key columns are always
    # c0..cN-1 and the join never has to look the positions up.
    members = _members_by_alias(definition)
    branches: list[BranchPlan] = []
    for alias, spec in active.items():
        shared_dims: list[str] = []
        labels: list[str] = []
        for key in selected_keys:
            shared = shared_map[key.strip().lower()]
            binding = shared.bindings.get(alias) or _binding_for(shared, alias)
            if binding is None:
                raise _error(
                    f"{key!r} is not mapped to {alias!r} in this model, so "
                    f"{alias!r} cannot be grouped by it. Add the binding, or "
                    "leave that view out of this question."
                )
            shared_dims.append(f"{binding.table}.{binding.column}")
            label = _binding_for(shared, alias, labels=True)
            if label is not None:
                labels.append(f"{label.table}.{label.column}")

        branch_filters = list(spec["filters"])
        for item in filters:
            ref = getattr(item, "field", "")
            if ":" in ref:
                continue
            shared = shared_map.get(ref.strip().lower())
            if shared is None:
                raise _error(
                    f"Cannot filter on {ref!r}: it is not a shared dimension "
                    "of this model. Filter a view's own field as "
                    "alias:TABLE.FIELD."
                )
            binding = _binding_for(shared, alias)
            if binding is None:
                raise _error(
                    f"Cannot filter on {ref!r}: it is not mapped to "
                    f"{alias!r}, which this question also asks."
                )
            # The same question asked of every member in its own words, so
            # it narrows all of them equally and creates no gate.
            branch_filters.append(
                item.model_copy(update={"field": f"{binding.table}.{binding.column}"})
            )

        member = members[alias]
        request = SemanticQueryRequest(
            database=member.database,
            schema=member.schema_,
            view=member.view,
            dimensions=shared_dims + labels + spec["local_dims"],
            metrics=spec["metrics"],
            filters=branch_filters,
        )
        branches.append(
            BranchPlan(
                alias=alias,
                database=member.database,
                schema=member.schema_,
                view=member.view,
                request=request,
                key_positions=list(range(len(selected_keys))),
                locally_filtered=spec["locally_filtered"],
            )
        )

    # Key columns are emitted only for branches that actually ran.
    for key in selected_keys:
        columns.insert(
            selected_keys.index(key),
            OutputColumn(
                name=key,
                kind="key",
                sources=[(b.alias, selected_keys.index(key)) for b in branches],
            ),
        )

    # Resolve every "which column of which branch" now, while the order
    # each branch requested its fields in is still known here.
    _bind_columns(columns, branches, selected_keys)

    return StitchPlan(
        branches=branches,
        keys=selected_keys,
        join_type=definition.joinType,
        cross_filter=definition.crossFilter,
        columns=columns,
        order_by=list(order_by or []),
        limit=limit,
    )


def _binding_for(shared, alias: str, *, labels: bool = False):
    """A member's binding for one shared dimension, matched case-blind.

    Aliases are compared lower-cased because the definition stores them
    as the author typed them, and a model that worked until somebody
    capitalised a letter would be a poor kind of governed.
    """
    source = (shared.labels or {}) if labels else shared.bindings
    for key, binding in source.items():
        if key.lower() == alias.lower():
            return binding
    return None


def _refs_of(node) -> list[str]:
    """Every metric reference in an expression tree, in order."""
    metric = getattr(node, "metric", None)
    if metric is not None:
        return [metric]
    left = getattr(node, "left", None)
    if left is None:
        return []
    return _refs_of(left) + _refs_of(getattr(node, "right"))


def _bind_columns(
    columns: list[OutputColumn], branches: list[BranchPlan], keys: list[str]
) -> None:
    """Turn field references into (alias, projected position) pairs.

    A branch projects `dimensions + metrics` as c0, c1, ... so a field's
    position is its index in that concatenation. Doing it here, once,
    keeps the compiler free of any knowledge about the model.
    """
    by_alias = {b.alias: b for b in branches}
    for column in columns:
        if column.kind == "key":
            index = keys.index(column.name)
            column.sources = [(alias, index) for alias, _ in column.sources]
        elif column.kind == "field":
            alias = column.sources[0][0]
            plan_ = by_alias[alias]
            _, rest = split_ref(column.name)
            if rest in plan_.request.metrics:
                position = len(plan_.request.dimensions) + plan_.request.metrics.index(rest)
            else:
                position = plan_.request.dimensions.index(rest)
            column.sources = [(alias, position)]
