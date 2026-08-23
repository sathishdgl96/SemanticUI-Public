"""The join graph a semantic view declares, and what it permits.

Snowflake decides for itself which entity a SEMANTIC_VIEW query is rooted
at, and refuses anything it cannot reach from there. The rules encoded here
were not read from documentation -- they were established by running ~80
combinations against a real account (see
docs/superpowers/specs/2026-08-16-join-graph-findings.md), and
tests/integration/test_joins_it.py re-runs the load-bearing ones so drift
in Snowflake's behaviour fails a test rather than reaching a user.
"""

from app.semantic.joins import build_join_graph, plan_join, reachable, resolve_base

# The TPCH shape, which is the one every finding below was verified against.
# Edges point from the FOREIGN key side to the PRIMARY key side, so following
# an edge always moves from finer grain to coarser.
TPCH = {
    "tables": [
        {"name": t}
        for t in ["CUSTOMERS", "LINEITEMS", "NATION", "ORDERS", "PART", "REGION", "SUPPLIER"]
    ],
    "relationships": [
        {"name": "CUSTOMERS_TO_NATION", "table": "CUSTOMERS", "refTable": "NATION"},
        {"name": "LINEITEMS_TO_ORDERS", "table": "LINEITEMS", "refTable": "ORDERS"},
        {"name": "LINEITEMS_TO_PART", "table": "LINEITEMS", "refTable": "PART"},
        {"name": "LINEITEMS_TO_SUPPLIER", "table": "LINEITEMS", "refTable": "SUPPLIER"},
        {"name": "NATION_TO_REGION", "table": "NATION", "refTable": "REGION"},
        {"name": "ORDERS_TO_CUSTOMERS", "table": "ORDERS", "refTable": "CUSTOMERS"},
    ],
    "dimensions": [
        {"table": "CUSTOMERS", "name": "CUSTOMER_NAME", "dataType": "VARCHAR"},
        {"table": "LINEITEMS", "name": "RETURN_FLAG", "dataType": "VARCHAR"},
        {"table": "NATION", "name": "NATION_NAME", "dataType": "VARCHAR"},
        {"table": "ORDERS", "name": "ORDER_DATE", "dataType": "DATE"},
        {"table": "PART", "name": "BRAND", "dataType": "VARCHAR"},
        {"table": "REGION", "name": "REGION_NAME", "dataType": "VARCHAR"},
        {"table": "SUPPLIER", "name": "SUPPLIER_NAME", "dataType": "VARCHAR"},
    ],
    "metrics": [
        {"table": "CUSTOMERS", "name": "CUSTOMER_COUNT", "dataType": "NUMBER"},
        {"table": "LINEITEMS", "name": "AVG_DISCOUNT", "dataType": "NUMBER"},
        {"table": "LINEITEMS", "name": "TOTAL_QUANTITY", "dataType": "NUMBER"},
        {"table": "ORDERS", "name": "ORDER_COUNT", "dataType": "NUMBER"},
    ],
    "facts": [],
}


class TestGraph:
    def test_edges_run_from_the_foreign_key_side_to_the_primary_key_side(self):
        graph = build_join_graph(TPCH)
        assert graph["LINEITEMS"] == {"ORDERS", "PART", "SUPPLIER"}
        assert graph["ORDERS"] == {"CUSTOMERS"}
        # A leaf still appears as a node, so reachability never KeyErrors on it.
        assert graph["REGION"] == set()

    def test_reachability_is_transitive_and_includes_the_start(self):
        graph = build_join_graph(TPCH)
        assert reachable(graph, "LINEITEMS") == {
            "LINEITEMS", "ORDERS", "PART", "SUPPLIER", "CUSTOMERS", "NATION", "REGION",
        }
        # Coarse entities see almost nothing: this asymmetry IS the grain rule.
        assert reachable(graph, "REGION") == {"REGION"}

    def test_a_cycle_does_not_hang(self):
        cyclic = {
            "tables": [{"name": "A"}, {"name": "B"}],
            "relationships": [
                {"name": "A_B", "table": "A", "refTable": "B"},
                {"name": "B_A", "table": "B", "refTable": "A"},
            ],
        }
        graph = build_join_graph(cyclic)
        assert reachable(graph, "A") == {"A", "B"}

    def test_relationships_without_endpoints_contribute_no_edges(self):
        # What a `DESCRIBE` cached before this feature existed looks like: the
        # names survived, the endpoints did not. Producing a node-only graph
        # (rather than guessing edges from the A_TO_B naming convention) is
        # what lets plan_join stand down instead of rejecting valid queries.
        stale = {"tables": [{"name": "ORDERS"}], "relationships": ["ORDERS_TO_CUSTOMERS"]}
        assert build_join_graph(stale) == {"ORDERS": set()}

    def test_resolve_base_picks_the_entity_that_reaches_all_the_others(self):
        graph = build_join_graph(TPCH)
        assert resolve_base(graph, {"ORDERS", "CUSTOMERS", "REGION"}) == "ORDERS"
        assert resolve_base(graph, {"REGION"}) == "REGION"
        # PART and SUPPLIER are siblings under LINEITEMS: neither reaches the
        # other, so no SELECTED entity can be the base.
        assert resolve_base(graph, {"PART", "SUPPLIER"}) is None


class TestDimensionOnlyQueries:
    def test_a_reachable_set_needs_no_bridge(self):
        plan = plan_join(TPCH, {"ORDERS", "CUSTOMERS"}, set())
        assert plan.bridge is None
        assert plan.blocked == ()

    def test_sibling_entities_are_bridged_through_their_common_child(self):
        # Snowflake's own error names LINEITEMS here ("Consider using one of
        # the following as a bridge"). Rather than surface that to a user, the
        # query includes a LINEITEMS metric and projects it away.
        plan = plan_join(TPCH, {"PART", "SUPPLIER"}, set())
        assert plan.bridge == "LINEITEMS"
        assert plan.blocked == ()

    def test_the_bridge_must_carry_a_metric_to_be_usable(self):
        # A bridge is smuggled in as a METRIC, because a bridging DIMENSION
        # would change the grain of the result -- new rows, not just a join.
        # An entity with no metric therefore cannot serve.
        detail = {**TPCH, "metrics": [m for m in TPCH["metrics"] if m["table"] != "LINEITEMS"]}
        plan = plan_join(detail, {"PART", "SUPPLIER"}, set())
        assert plan.bridge is None
        assert set(plan.blocked) == {"PART", "SUPPLIER"}

    def test_a_graph_with_no_edges_never_interferes(self):
        stale = {**TPCH, "relationships": ["ORDERS_TO_CUSTOMERS"]}
        plan = plan_join(stale, {"PART", "SUPPLIER"}, set())
        assert plan.bridge is None
        assert plan.blocked == ()


class TestQueriesWithMetrics:
    def test_a_metric_reaches_every_dimension_above_it(self):
        plan = plan_join(TPCH, {"PART", "REGION"}, {"LINEITEMS"})
        assert plan.blocked == ()
        assert plan.bridge is None

    def test_a_coarse_metric_cannot_be_broken_down_by_a_finer_dimension(self):
        plan = plan_join(TPCH, {"ORDERS"}, {"CUSTOMERS"})
        assert plan.blocked == ("ORDERS",)
        assert plan.base == "CUSTOMERS"

    def test_every_metric_entity_is_checked_not_just_the_finest(self):
        # Listing LINEITEMS first does not rescue ORDERS: verified against a
        # real account, clause order has no effect on which entities are
        # checked.
        plan = plan_join(TPCH, {"PART"}, {"LINEITEMS", "ORDERS"})
        assert plan.blocked == ("PART",)
        assert plan.base == "ORDERS"

    def test_it_suggests_metrics_that_would_actually_work(self):
        plan = plan_join(TPCH, {"PART"}, {"CUSTOMERS"})
        assert plan.blocked == ("PART",)
        # LINEITEMS reaches PART; ORDERS does not, so it must not be offered.
        assert plan.alternatives == ("LINEITEMS.AVG_DISCOUNT", "LINEITEMS.TOTAL_QUANTITY")

    def test_a_blocked_metric_query_is_never_bridged(self):
        # Adding a LINEITEMS metric does NOT rescue a coarse user metric --
        # Snowflake checks every metric entity, so the coarse one still fails.
        # Verified; the plan must not pretend otherwise.
        plan = plan_join(TPCH, {"PART", "SUPPLIER"}, {"ORDERS"})
        assert plan.bridge is None
