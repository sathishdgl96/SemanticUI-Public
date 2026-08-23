"""The join graph a semantic view declares, and what it lets you ask.

A `SEMANTIC_VIEW(...)` query is rooted at a *base entity* that Snowflake
picks for itself, and every other entity named in the query has to be
reachable from it by following declared relationships. Nothing in the
grammar hints at this; it shows up only as a compilation error at run time,
in three flavours that all begin "Invalid dimension specified".

The rules below were established empirically against a real account, not
read from documentation -- roughly eighty combinations, recorded in
docs/superpowers/specs/2026-08-16-join-graph-findings.md. In short:

* Relationship edges run from the FOREIGN key side to the PRIMARY key side,
  so following an edge always moves from finer grain to coarser.
* With metrics selected, EVERY metric's entity is a base, and every selected
  dimension must be reachable from every one of them. Clause order has no
  effect -- listing a fine-grained metric first does not rescue a coarse one.
* With only dimensions selected, one of them must reach all the others. When
  none does -- two siblings under a common child, say -- naming a third
  entity that reaches both repairs the query. That is what `bridge` is.

`tests/integration/test_joins_it.py` re-runs the load-bearing cases against
Snowflake, so if any of this ever stops being true, a test says so.
"""

from collections import deque
from dataclasses import dataclass

Graph = dict[str, set[str]]


def build_join_graph(detail: dict) -> Graph:
    """Table -> the tables it directly references, upper-cased.

    A relationship with no endpoints contributes no edge. That is not a
    defensive flourish: a `DESCRIBE` cached before this module existed holds
    relationship *names* only, and inferring edges from the `A_TO_B` naming
    convention would be a guess. An edgeless graph makes `plan_join` stand
    down entirely, which is the right behaviour when we do not know the
    shape -- better a Snowflake error than a wrong refusal of our own.
    """
    graph: Graph = {}
    for table in detail.get("tables") or []:
        name = (table.get("name") or "").upper()
        if name:
            graph.setdefault(name, set())
    for relationship in detail.get("relationships") or []:
        if not isinstance(relationship, dict):
            continue
        source = (relationship.get("table") or "").upper()
        target = (relationship.get("refTable") or "").upper()
        if not source or not target:
            continue
        graph.setdefault(source, set()).add(target)
        graph.setdefault(target, set())
    return graph


def reachable(graph: Graph, start: str) -> set[str]:
    """Everything reachable from `start`, including `start` itself."""
    seen = {start}
    queue = deque([start])
    while queue:
        for neighbour in graph.get(queue.popleft(), ()):
            if neighbour not in seen:
                seen.add(neighbour)
                queue.append(neighbour)
    return seen


def resolve_base(graph: Graph, tables: set[str]) -> str | None:
    """A member of `tables` that reaches every other member, or None.

    Sorted so a graph with several valid bases always picks the same one --
    the SQL a report emits must not depend on set iteration order.
    """
    for candidate in sorted(tables):
        if tables <= reachable(graph, candidate):
            return candidate
    return None


def _metrics_by_table(detail: dict) -> dict[str, list[str]]:
    by_table: dict[str, list[str]] = {}
    for metric in detail.get("metrics") or []:
        by_table.setdefault((metric.get("table") or "").upper(), []).append(metric["name"])
    return {table: sorted(names) for table, names in by_table.items()}


@dataclass(frozen=True)
class JoinPlan:
    """What has to happen for a set of entities to be queryable together.

    Exactly one of these is interesting at a time: either a `bridge` repairs
    the query, or `blocked` says which dimensions cannot be answered and
    `alternatives` says what to measure instead.
    """

    #: Entity to smuggle into the query as a metric and project away, so a
    #: dimension-only query across unrelated entities compiles. None when the
    #: query needs no repair or cannot be repaired.
    bridge: str | None = None
    #: The entity Snowflake will root the query at when something is blocked.
    base: str | None = None
    #: Dimension entities unreachable from `base`, sorted.
    blocked: tuple[str, ...] = ()
    #: Metric refs ("TABLE.NAME") that WOULD reach every selected dimension.
    alternatives: tuple[str, ...] = ()


def plan_join(detail: dict, dimension_tables: set[str], metric_tables: set[str]) -> JoinPlan:
    graph = build_join_graph(detail)
    if not any(graph.values()):
        # No edges known -- see build_join_graph. Say nothing rather than
        # guess: every query behaves exactly as it did before this module.
        return JoinPlan()

    dimension_tables = {t.upper() for t in dimension_tables}
    metric_tables = {t.upper() for t in metric_tables}

    if metric_tables:
        # Each metric entity is a base in its own right, and the query fails
        # if ANY of them cannot see a selected dimension. Reported against the
        # worst offender -- the one blocking the most -- so removing what the
        # message names actually fixes the query.
        worst: tuple[str, tuple[str, ...]] | None = None
        for base in sorted(metric_tables):
            unreachable = tuple(sorted(dimension_tables - reachable(graph, base)))
            if unreachable and (worst is None or len(unreachable) > len(worst[1])):
                worst = (base, unreachable)
        if worst is None:
            return JoinPlan()
        # A bridge cannot help here: the coarse metric the user asked for is
        # still a base, and still cannot see the dimension. Verified.
        alternatives = tuple(
            f"{table}.{name}"
            for table, names in sorted(_metrics_by_table(detail).items())
            if dimension_tables <= reachable(graph, table)
            for name in names
        )
        return JoinPlan(base=worst[0], blocked=worst[1], alternatives=alternatives)

    if len(dimension_tables) < 2 or resolve_base(graph, dimension_tables) is not None:
        return JoinPlan()

    # Nothing selected reaches everything else, so look for an entity that
    # does. Ranked by total distance, so the bridge is the closest common
    # descendant rather than merely the first one found; the name breaks ties
    # so the emitted SQL is stable.
    with_metrics = _metrics_by_table(detail)
    candidates: list[tuple[int, str]] = []
    for candidate in sorted(graph):
        if candidate in dimension_tables or candidate not in with_metrics:
            continue
        if dimension_tables <= reachable(graph, candidate):
            candidates.append((_total_distance(graph, candidate, dimension_tables), candidate))
    if not candidates:
        return JoinPlan(blocked=tuple(sorted(dimension_tables)))
    return JoinPlan(bridge=min(candidates)[1])


def _total_distance(graph: Graph, start: str, targets: set[str]) -> int:
    distance = {start: 0}
    queue = deque([start])
    while queue:
        node = queue.popleft()
        for neighbour in graph.get(node, ()):
            if neighbour not in distance:
                distance[neighbour] = distance[node] + 1
                queue.append(neighbour)
    return sum(distance.get(target, 0) for target in targets)
