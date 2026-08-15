"""The visual catalog: what each visual type accepts and how it queries.

Wells are declared per visual type rather than shared, because scatter needs
two *metrics* on its axes while bar/line/area need a dimension on one. A fixed
Axis/Legend/Values triple cannot express both.

`frontend/src/reports/catalog.ts` mirrors this file. Both are tested against
the same expectations so they cannot drift apart silently.
"""

from dataclasses import dataclass
from typing import Literal

FieldKind = Literal["dimension", "metric"]

# A well entry of the form "hierarchy:<id>" stands in for a whole drill path
# rather than a single field. Declared here rather than in schema.py because
# both modules need it and schema.py already imports from this one.
HIERARCHY_PREFIX = "hierarchy:"


@dataclass(frozen=True)
class WellSpec:
    key: str
    label: str
    kind: FieldKind
    min: int
    max: int | None  # None = unbounded


@dataclass(frozen=True)
class VisualSpec:
    type: str
    label: str
    wells: tuple[WellSpec, ...]
    #: Option keys this type understands; anything else is rejected on import.
    options: frozenset[str]

    def well(self, key: str) -> WellSpec | None:
        return next((w for w in self.wells if w.key == key), None)


_CATEGORICAL = (
    WellSpec("axis", "Axis", "dimension", 1, 1),
    WellSpec("legend", "Legend", "dimension", 0, 1),
    WellSpec("values", "Values", "metric", 1, None),
)

CATALOG: dict[str, VisualSpec] = {
    "bar": VisualSpec("bar", "Bar", _CATEGORICAL, frozenset({"stacked"})),
    "line": VisualSpec("line", "Line", _CATEGORICAL, frozenset()),
    "area": VisualSpec("area", "Area", _CATEGORICAL, frozenset({"stacked"})),
    "pie": VisualSpec(
        "pie",
        "Pie",
        (
            WellSpec("legend", "Legend", "dimension", 1, 1),
            WellSpec("values", "Values", "metric", 1, 1),
        ),
        frozenset({"donut"}),
    ),
    "scatter": VisualSpec(
        "scatter",
        "Scatter",
        (
            WellSpec("x", "X axis", "metric", 1, 1),
            WellSpec("y", "Y axis", "metric", 1, 1),
            WellSpec("detail", "Detail", "dimension", 0, 1),
        ),
        frozenset(),
    ),
    "table": VisualSpec(
        "table",
        "Table",
        (
            WellSpec("dimensions", "Dimensions", "dimension", 0, None),
            WellSpec("metrics", "Metrics", "metric", 0, None),
        ),
        frozenset(),
    ),
    "kpi": VisualSpec(
        "kpi",
        "KPI card",
        (WellSpec("value", "Value", "metric", 1, 1),),
        frozenset({"format"}),
    ),
}


def wells_to_query(
    visual_type: str,
    wells: dict[str, list[str]],
    hierarchies: dict[str, list[str]] | None = None,
) -> tuple[list[str], list[str]]:
    """Flatten a visual's wells into the (dimensions, metrics) the query API takes.

    Order matters: dimensions come out in well-declaration order, so for a bar
    the axis precedes the legend and the caller can rely on that when pivoting.

    A "hierarchy:<id>" entry expands to EVERY level of that hierarchy. Callers
    use this for validation -- "can this user see all the fields this report
    could drill to?" -- not for querying: the client picks the single level to
    select from the current drill position before it calls the query API.
    """
    spec = CATALOG[visual_type]
    lookup = hierarchies or {}
    dimensions: list[str] = []
    metrics: list[str] = []
    for well in spec.wells:
        target = dimensions if well.kind == "dimension" else metrics
        for ref in wells.get(well.key, []):
            if ref.startswith(HIERARCHY_PREFIX):
                # An unknown id yields nothing: parse_definition has already
                # rejected undeclared references, so the only way to get here
                # is a caller that passed no map -- and emitting the raw
                # "hierarchy:h9" would surface as a bogus unknown-field error.
                target.extend(lookup.get(ref[len(HIERARCHY_PREFIX):], []))
            else:
                target.append(ref)
    return dimensions, metrics


def validate_wells(visual_type: str, wells: dict[str, list[str]]) -> list[str]:
    """Return human-readable problems with this well arrangement; [] if valid."""
    spec = CATALOG.get(visual_type)
    if spec is None:
        return [f"Unknown visual type: {visual_type}"]

    problems: list[str] = []
    known = {w.key for w in spec.wells}
    for key in wells:
        if key not in known:
            problems.append(f"{spec.label} has no well named {key!r} (bogus well)")

    seen: dict[str, str] = {}
    for well in spec.wells:
        refs = wells.get(well.key, [])
        if len(refs) < well.min:
            problems.append(f"{well.label} needs at least {well.min} field(s)")
        if well.max is not None and len(refs) > well.max:
            problems.append(f"{well.label} takes at most {well.max} field(s)")
        for ref in refs:
            if ref in seen:
                problems.append(
                    f"{ref} appears in more than one well ({seen[ref]} and {well.label})"
                )
            else:
                seen[ref] = well.label

    if visual_type == "table" and not seen:
        problems.append("Table needs at least one field")
    return problems
