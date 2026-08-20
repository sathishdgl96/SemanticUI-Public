"""A composite model, dressed as a cube.

Excel talks to cubes. Everything in `discover.py` reads two things — a
view dict (`database`/`schema`/`name`) and a describe `detail` — and
knows nothing else about where they came from. So a composite is
presented as a **synthetic view with a synthetic detail**, and the whole
discovery surface works on it unchanged: cubes, dimensions, hierarchies,
levels, measures, measure groups.

The naming, which is the only subtle part:

    shared dimension "Customer"    ->  table = the model's name,  name = "Customer"
    derived metric "Revenue/ticket"->  table = the model's name,  name = "Revenue/ticket"
    a member's own field           ->  table = the member alias,  name = "ORDERS.REVENUE"

so Excel sees `[sales].[ORDERS.REVENUE]` and `[Measures].[sales.ORDERS.REVENUE]`.
A dot inside a bracketed name is safe: the MDX tokenizer consumes `[...]`
whole, and the existing single-view path already names every measure
`TABLE.NAME` for exactly this reason.

Mapping back is therefore a split on the FIRST dot — member aliases match
`[A-Za-z][A-Za-z0-9_]*` and cannot contain one, and the model's own
folder name is chosen below so it cannot collide with an alias.

Nothing here queries Snowflake. The synthetic detail is built from the
model's definition plus each member's real describe, which the caller has
already fetched on the user's own connection.
"""

from typing import Any

from app.composites.schema import CompositeDefinition

#: The pseudo-database every model appears under, so a cube name stays
#: three parts and models sort together in Excel's cube list.
MODEL_DATABASE = "Models"


def folder_name(definition: CompositeDefinition) -> str:
    """The dimension folder shared fields live in.

    The model's own name, which is what a person expects to see above
    "Customer". Aliases cannot contain a space, so a name that collides
    with one gets a space appended rather than silently shadowing it.
    """
    name = (definition.name or "Model").strip() or "Model"
    aliases = {member.alias.lower() for member in definition.members}
    while name.lower() in aliases:
        name = f"{name} "
    return name


def synthetic_view(composite, workspace_name: str) -> dict:
    """The view dict a composite is seen as.

    `composite_id` is what tells the rest of the code this is a model;
    every other key is what `discover.py` already expects.
    """
    # Dots would split the cube name in the wrong place, and a workspace
    # is free to have one in its name.
    schema = (workspace_name or "Models").replace(".", " ") or "Models"
    return {
        "database": MODEL_DATABASE,
        "schema": schema,
        "name": (composite.name or "Untitled model").replace(".", " "),
        "comment": "",
        "composite_id": str(composite.id),
    }


def is_composite(view: dict) -> bool:
    return bool(view.get("composite_id"))


def synthetic_detail(
    definition: CompositeDefinition, describes: dict[str, dict]
) -> dict:
    """The describe a composite cube answers with.

    `describes` maps a member alias to that view's real describe. A member
    that could not be described — the user cannot read it, or it is gone —
    is simply absent, and contributes nothing rather than making the whole
    cube unreadable.

    Relationships are deliberately empty. They exist so `plan_join` can
    tell which field combinations one view can answer; across a model the
    join is the conformed dimensions, and every combination the model
    exposes is answerable by construction.
    """
    folder = folder_name(definition)
    dimensions: list[dict] = []
    metrics: list[dict] = []

    bound: dict[str, set[tuple[str, str]]] = {}
    for shared in definition.sharedDimensions:
        dimensions.append(
            {"table": folder, "name": shared.name, "dataType": "TEXT"}
        )
        for alias, binding in shared.bindings.items():
            bound.setdefault(alias.lower(), set()).add(
                (binding.table.upper(), binding.column.upper())
            )
        for alias, label in (shared.labels or {}).items():
            bound.setdefault(alias.lower(), set()).add(
                (label.table.upper(), label.column.upper())
            )

    for member in definition.members:
        alias = member.alias
        detail = describes.get(alias.lower())
        if not detail:
            continue
        taken = bound.get(alias.lower(), set())
        for field in detail.get("dimensions", []):
            table, name = field.get("table") or "", field.get("name") or ""
            if not table or not name:
                continue
            # A column already exposed as a shared dimension is not offered
            # again under the member: two fields that are the same thing
            # would be two ways to group by it, giving different answers
            # depending which one somebody dragged.
            if (table.upper(), name.upper()) in taken:
                continue
            dimensions.append(
                {
                    "table": alias,
                    "name": f"{table}.{name}",
                    "dataType": field.get("dataType"),
                }
            )
        for metric in detail.get("metrics", []):
            table, name = metric.get("table") or "", metric.get("name") or ""
            if not table or not name:
                continue
            metrics.append(
                {
                    "table": alias,
                    "name": f"{table}.{name}",
                    "dataType": metric.get("dataType"),
                }
            )

    for derived in definition.derivedMetrics:
        metrics.append({"table": folder, "name": derived.name, "dataType": None})

    return {
        "tables": [{"name": folder}]
        + [{"name": member.alias} for member in definition.members],
        "relationships": [],
        "dimensions": dimensions,
        "metrics": metrics,
        "facts": [],
        "hierarchies": [],
    }


def to_model_ref(definition: CompositeDefinition, ref: str) -> str:
    """`sales.ORDERS.REVENUE` -> `sales:ORDERS.REVENUE`; `Model.Customer` -> `Customer`.

    The inverse of the naming above. Split on the first dot: the left side
    is either the model's own folder (a shared dimension or a derived
    metric, which the planner takes bare) or a member alias.
    """
    head, _, rest = ref.partition(".")
    if not rest:
        return ref
    if head.lower() == folder_name(definition).lower():
        return rest
    return f"{head}:{rest}"


def to_model_refs(definition: CompositeDefinition, refs: list[str]) -> list[str]:
    return [to_model_ref(definition, ref) for ref in refs]


def split_selection(
    definition: CompositeDefinition, refs: list[str]
) -> tuple[list[str], list[str]]:
    """Model refs, split into (dimensions, metrics).

    The planner keeps the two namespaces apart by which list a reference
    arrives in, and MDX hands measures and attributes over separately —
    but a *filter* names a field without saying which it is, so this
    decides from the definition rather than from the shape of the string.
    """
    metric_names = {m.name.strip().lower() for m in definition.derivedMetrics}
    dimensions, metrics = [], []
    for ref in refs:
        if ":" not in ref and ref.strip().lower() in metric_names:
            metrics.append(ref)
        else:
            dimensions.append(ref)
    return dimensions, metrics


def member_describes(session: Any, definition: CompositeDefinition) -> dict[str, dict]:
    """Each member's real describe, on the caller's own connection.

    A member the caller cannot read is skipped rather than raising: a
    model naming one view they may not see should still expose the ones
    they may, and Snowflake refuses the rest when a query actually asks.
    """
    out: dict[str, dict] = {}
    for member in definition.members:
        try:
            out[member.alias.lower()] = session.describe(
                member.database, member.schema_, member.view
            )
        except Exception:
            continue
    return out
