"""Planning and compiling a question that spans several semantic views.

The properties under test, in order of how badly getting them wrong
would hurt:

1. Each branch aggregates inside its own view before anything is joined,
   so raw rows from two views never meet and a fan trap cannot happen.
2. Bound parameters come back in the order the SQL emits placeholders.
   An off-by-one here binds one filter's value to another's placeholder
   and the query still succeeds -- with wrong numbers.
3. A question touching one member costs exactly the query that member
   would have got on its own.
"""

import pydantic
import pytest

from app.composites.compile import compile_composite
from app.composites.planner import plan
from app.composites.schema import parse_definition
from app.errors import ApiError
from app.reports.filters import FilterList
from app.semantic.query import OrderBy

SALES = {
    "tables": [{"name": "ORDERS"}, {"name": "CUSTOMER"}],
    "relationships": [
        {
            "name": "r",
            "table": "ORDERS",
            "refTable": "CUSTOMER",
            "foreignKey": ["CUSTOMER_ID"],
            "refKey": ["CUSTOMER_ID"],
        }
    ],
    "dimensions": [
        {"table": "CUSTOMER", "name": "CUSTOMER_ID"},
        {"table": "CUSTOMER", "name": "NAME"},
        {"table": "CUSTOMER", "name": "REGION"},
        {"table": "ORDERS", "name": "ORDER_MONTH"},
    ],
    "metrics": [{"table": "ORDERS", "name": "REVENUE"}],
    "facts": [],
    "hierarchies": [],
}

SUPPORT = {
    "tables": [{"name": "TICKETS"}, {"name": "CLIENT"}],
    "relationships": [
        {
            "name": "r2",
            "table": "TICKETS",
            "refTable": "CLIENT",
            "foreignKey": ["CLIENT_ID"],
            "refKey": ["CLIENT_ID"],
        }
    ],
    "dimensions": [
        {"table": "CLIENT", "name": "CLIENT_ID"},
        {"table": "TICKETS", "name": "OPENED_MONTH"},
        {"table": "TICKETS", "name": "PRIORITY"},
    ],
    "metrics": [{"table": "TICKETS", "name": "TICKET_COUNT"}],
    "facts": [],
    "hierarchies": [],
}

DESCRIBES = {"sales": SALES, "support": SUPPORT}


def model(**over):
    doc = {
        "schemaVersion": 1,
        "name": "Customer 360",
        "members": [
            {"alias": "sales", "database": "A", "schema": "P", "view": "SALES_SV"},
            {"alias": "support", "database": "A", "schema": "P", "view": "SUPPORT_SV"},
        ],
        "sharedDimensions": [
            {
                "name": "Customer",
                "bindings": {
                    "sales": {"table": "CUSTOMER", "column": "CUSTOMER_ID"},
                    "support": {"table": "CLIENT", "column": "CLIENT_ID"},
                },
            },
            {
                "name": "Month",
                "bindings": {
                    "sales": {"table": "ORDERS", "column": "ORDER_MONTH"},
                    "support": {"table": "TICKETS", "column": "OPENED_MONTH"},
                },
            },
        ],
        "derivedMetrics": [
            {
                "name": "Revenue per ticket",
                "expr": {
                    "op": "/",
                    "left": {"metric": "sales:ORDERS.REVENUE"},
                    "right": {"metric": "support:TICKETS.TICKET_COUNT"},
                },
            }
        ],
    }
    doc.update(over)
    return parse_definition(doc)


class _Wrapper(pydantic.BaseModel):
    filters: FilterList = []


def filters(*raw):
    return _Wrapper(filters=list(raw)).filters


def compiled(definition, **kwargs):
    kwargs.setdefault("limit", None)
    stitch = plan(definition, **kwargs)
    return compile_composite(stitch, DESCRIBES, max_rows=200)


# ------------------------------------------------------- routing


def test_a_metric_routes_to_the_view_that_owns_it():
    stitch = plan(
        model(),
        dimensions=["Customer"],
        metrics=["sales:ORDERS.REVENUE", "support:TICKETS.TICKET_COUNT"],
    )
    assert sorted(b.alias for b in stitch.branches) == ["sales", "support"]


def test_a_question_touching_one_view_runs_one_branch():
    # Branch pruning: you must not pay for the composite machinery when
    # the question does not span anything.
    stitch = plan(model(), dimensions=["Customer"], metrics=["sales:ORDERS.REVENUE"])
    assert [b.alias for b in stitch.branches] == ["sales"]
    sql, _, _ = compile_composite(stitch, DESCRIBES, max_rows=200)
    assert "JOIN" not in sql


def test_a_derived_metric_pulls_in_the_branches_it_needs():
    # Asking only for the ratio must still fetch both its operands.
    stitch = plan(model(), dimensions=["Customer"], metrics=["Revenue per ticket"])
    assert sorted(b.alias for b in stitch.branches) == ["sales", "support"]


def test_an_unknown_shared_dimension_is_refused_by_name():
    with pytest.raises(ApiError) as caught:
        plan(model(), dimensions=["Galaxy"], metrics=["sales:ORDERS.REVENUE"])
    assert "Galaxy" in str(caught.value.message)


def test_spanning_two_views_without_a_shared_dimension_is_refused():
    # There would be nothing to line the two answers up on, and a cross
    # join of two aggregates is never the intended question.
    with pytest.raises(ApiError) as caught:
        plan(
            model(),
            dimensions=["sales:CUSTOMER.NAME"],
            metrics=["sales:ORDERS.REVENUE", "support:TICKETS.TICKET_COUNT"],
        )
    assert "shared dimension" in str(caught.value.message)


def test_a_field_of_an_unknown_member_is_refused():
    with pytest.raises(ApiError) as caught:
        plan(model(), dimensions=["Customer"], metrics=["ghost:X.Y"])
    assert "ghost" in str(caught.value.message)


# ------------------------------------------------------- the SQL


def test_each_branch_aggregates_before_anything_is_joined():
    # The property that makes fan traps impossible: every branch is a
    # complete SEMANTIC_VIEW query, so what the join sees is already
    # summarised at the shared grain.
    sql, _, _ = compiled(
        model(),
        dimensions=["Customer"],
        metrics=["sales:ORDERS.REVENUE", "support:TICKETS.TICKET_COUNT"],
    )
    assert sql.count("SEMANTIC_VIEW(") == 2
    assert "FULL OUTER JOIN" in sql
    # The join is on the branches' key columns, never on raw tables.
    assert '"b_sales"."c0" = "b_support"."c0"' in sql


def test_keys_are_coalesced_so_a_row_present_in_one_view_survives():
    sql, _, _ = compiled(
        model(),
        dimensions=["Customer"],
        metrics=["sales:ORDERS.REVENUE", "support:TICKETS.TICKET_COUNT"],
    )
    assert 'COALESCE("b_sales"."c0", "b_support"."c0") AS "Customer"' in sql


def test_inner_join_is_used_when_the_model_says_so():
    sql, _, _ = compiled(
        model(joinType="inner"),
        dimensions=["Customer"],
        metrics=["sales:ORDERS.REVENUE", "support:TICKETS.TICKET_COUNT"],
    )
    assert "INNER JOIN" in sql
    assert "FULL OUTER JOIN" not in sql


def test_a_derived_metric_is_computed_after_aggregation():
    sql, _, _ = compiled(
        model(), dimensions=["Customer"], metrics=["Revenue per ticket"]
    )
    # Over the branches' output columns, not inside either view.
    assert 'CASE WHEN "b_support"."c1" = 0 THEN NULL' in sql
    assert '"b_sales"."c1" / "b_support"."c1"' in sql


def test_division_by_zero_can_be_left_to_fail_if_the_model_says_so():
    definition = model(
        derivedMetrics=[
            {
                "name": "Ratio",
                "expr": {
                    "op": "/",
                    "left": {"metric": "sales:ORDERS.REVENUE"},
                    "right": {"metric": "support:TICKETS.TICKET_COUNT"},
                },
                "nullIfDenominatorZero": False,
            }
        ]
    )
    sql, _, _ = compiled(definition, dimensions=["Customer"], metrics=["Ratio"])
    assert "CASE WHEN" not in sql


def test_multiple_shared_dimensions_all_join():
    sql, _, _ = compiled(
        model(),
        dimensions=["Customer", "Month"],
        metrics=["sales:ORDERS.REVENUE", "support:TICKETS.TICKET_COUNT"],
    )
    assert '"b_sales"."c0" = "b_support"."c0"' in sql
    assert '"b_sales"."c1" = "b_support"."c1"' in sql


# ------------------------------------------------------- filters


def test_a_shared_filter_is_asked_of_every_branch_in_its_own_words():
    sql, params, _ = compiled(
        model(),
        dimensions=["Customer"],
        metrics=["sales:ORDERS.REVENUE", "support:TICKETS.TICKET_COUNT"],
        filters=filters(
            {"id": "f1", "field": "Month", "op": "is", "values": ["2026-01"]}
        ),
    )
    # Each member's own binding column, not a shared name Snowflake has
    # never heard of.
    assert '"ORDERS"."ORDER_MONTH"' in sql
    assert '"TICKETS"."OPENED_MONTH"' in sql
    assert params == ["2026-01", "2026-01"]


def test_a_local_filter_narrows_the_others_through_a_gate():
    sql, params, _ = compiled(
        model(),
        dimensions=["Customer"],
        metrics=["sales:ORDERS.REVENUE", "support:TICKETS.TICKET_COUNT"],
        filters=filters(
            {"id": "f1", "field": "sales:CUSTOMER.REGION", "op": "is", "values": ["EU"]}
        ),
    )
    # "Tickets for the customers this filter left" -- the semi default.
    assert '"g_sales" AS (' in sql
    assert 'IN (SELECT "c0" FROM "g_sales")' in sql
    assert params == ["EU", "EU"]


def test_local_cross_filter_mode_leaves_the_others_alone():
    sql, params, _ = compiled(
        model(crossFilter="local"),
        dimensions=["Customer"],
        metrics=["sales:ORDERS.REVENUE", "support:TICKETS.TICKET_COUNT"],
        filters=filters(
            {"id": "f1", "field": "sales:CUSTOMER.REGION", "op": "is", "values": ["EU"]}
        ),
    )
    assert "g_sales" not in sql
    assert params == ["EU"]


def test_two_locally_filtered_branches_do_not_reference_each_other():
    # Gates depend on nothing, which is the reason they exist: branch A
    # narrowing B while B narrows A would be a circular CTE.
    sql, params, _ = compiled(
        model(),
        dimensions=["Customer"],
        metrics=["sales:ORDERS.REVENUE", "support:TICKETS.TICKET_COUNT"],
        filters=filters(
            {"id": "f1", "field": "sales:CUSTOMER.REGION", "op": "is", "values": ["EU"]},
            {
                "id": "f2",
                "field": "support:TICKETS.PRIORITY",
                "op": "is",
                "values": ["HIGH"],
            },
        ),
    )
    assert sql.index('"g_sales" AS (') < sql.index('"b_sales" AS (')
    assert sql.index('"g_support" AS (') < sql.index('"b_support" AS (')
    # Each branch is narrowed by the OTHER's gate, never its own.
    sales_block = sql[sql.index('"b_sales" AS ('): sql.index('"b_support" AS (')]
    assert "g_support" in sales_block
    assert "g_sales" not in sales_block
    # Emission order: g_sales, g_support, b_sales, b_support.
    assert params == ["EU", "HIGH", "EU", "HIGH"]


def test_filtering_on_something_that_is_not_a_field_of_the_model_is_refused():
    with pytest.raises(ApiError) as caught:
        plan(
            model(),
            dimensions=["Customer"],
            metrics=["sales:ORDERS.REVENUE"],
            filters=filters(
                {"id": "f1", "field": "Nonsense", "op": "is", "values": ["x"]}
            ),
        )
    assert "Nonsense" in str(caught.value.message)


# ------------------------------------------------------- the outside


def test_order_by_names_an_output_column():
    sql, _, _ = compiled(
        model(),
        dimensions=["Customer"],
        metrics=["sales:ORDERS.REVENUE"],
        order_by=[OrderBy(field="sales:ORDERS.REVENUE", direction="desc")],
    )
    assert 'ORDER BY "sales:ORDERS.REVENUE" DESC' in sql
    # And only once, at the top: branch ordering decides nothing.
    assert sql.count("ORDER BY") == 1


def test_order_by_something_not_selected_is_refused():
    with pytest.raises(ApiError):
        compiled(
            model(),
            dimensions=["Customer"],
            metrics=["sales:ORDERS.REVENUE"],
            order_by=[OrderBy(field="support:TICKETS.TICKET_COUNT")],
        )


def test_the_row_cap_is_applied_once_at_the_top_with_the_usual_extra_row():
    sql, _, limit = compiled(
        model(), dimensions=["Customer"], metrics=["sales:ORDERS.REVENUE"]
    )
    assert limit == 200
    assert sql.rstrip().endswith("LIMIT 201")


def test_selecting_nothing_is_refused():
    with pytest.raises(ApiError):
        plan(model(), dimensions=[], metrics=[])


def test_no_filter_value_appears_in_the_sql():
    # The contract the whole codebase keeps: values bind, never interpolate.
    sql, params, _ = compiled(
        model(),
        dimensions=["Customer"],
        metrics=["sales:ORDERS.REVENUE", "support:TICKETS.TICKET_COUNT"],
        filters=filters(
            {"id": "f1", "field": "sales:CUSTOMER.REGION", "op": "is", "values": ["EU"]}
        ),
    )
    assert "EU" not in sql
    assert "EU" in params


def test_a_label_column_rides_along_with_its_key():
    definition = model(
        sharedDimensions=[
            {
                "name": "Customer",
                "bindings": {
                    "sales": {"table": "CUSTOMER", "column": "CUSTOMER_ID"},
                    "support": {"table": "CLIENT", "column": "CLIENT_ID"},
                },
                "labels": {"sales": {"table": "CUSTOMER", "column": "NAME"}},
            }
        ]
    )
    sql, _, _ = compiled(
        definition, dimensions=["Customer"], metrics=["sales:ORDERS.REVENUE"]
    )
    # Keys stay at c0 so the join is stable; the label follows.
    assert '"CUSTOMER_ID" AS "c0"' in sql
    assert '"NAME" AS "c1"' in sql


def test_shared_dimensions_alone_ask_every_view_that_knows_the_concept():
    # "Which customers exist?" names no metric and no member. The outer
    # join then unions the keys rather than the question being refused.
    stitch = plan(model(), dimensions=["Customer"], metrics=[])
    assert sorted(b.alias for b in stitch.branches) == ["sales", "support"]
    assert all(not b.request.metrics for b in stitch.branches)


def test_a_key_not_mapped_to_an_active_view_is_refused_by_name():
    # Region lives in sales only; asking for it beside a support metric
    # cannot be grouped, and saying which binding is missing is the whole
    # difference between a fixable error and a puzzling one.
    definition = model(
        sharedDimensions=[
            {
                "name": "Customer",
                "bindings": {
                    "sales": {"table": "CUSTOMER", "column": "CUSTOMER_ID"},
                    "support": {"table": "CLIENT", "column": "CLIENT_ID"},
                },
            },
            {
                "name": "Region",
                "bindings": {
                    "sales": {"table": "CUSTOMER", "column": "REGION"},
                    "support": {"table": "CLIENT", "column": "CLIENT_ID"},
                },
            },
        ]
    )
    # Drop the support binding to make Region sales-only.
    definition.sharedDimensions[1].bindings.pop("support")
    with pytest.raises(ApiError) as caught:
        plan(
            definition,
            dimensions=["Customer", "Region"],
            metrics=["sales:ORDERS.REVENUE", "support:TICKETS.TICKET_COUNT"],
        )
    assert "Region" in str(caught.value.message)
    assert "support" in str(caught.value.message)


def test_member_aliases_are_matched_case_blind():
    # The definition stores an alias as the author typed it; a model that
    # broke when somebody capitalised a letter would be a poor kind of
    # governed.
    stitch = plan(
        model(), dimensions=["Customer"], metrics=["SALES:ORDERS.REVENUE"]
    )
    assert [b.alias for b in stitch.branches] == ["sales"]


# ------------------------------------------- two dialects, one planner


class TestBuilderDialect:
    """The report builder names fields from a describe (`sales.ORDERS.REVENUE`);
    the model names them its own way (`sales:ORDERS.REVENUE`). One mapping
    serves both, and it has to be idempotent to do so."""

    def test_a_describe_ref_maps_to_a_model_ref(self):
        from app.xmla.composite_source import to_model_ref

        defn = model()
        assert to_model_ref(defn, "sales.ORDERS.REVENUE") == "sales:ORDERS.REVENUE"
        assert to_model_ref(defn, "Customer 360.Customer") == "Customer"

    def test_a_model_ref_survives_the_mapping_unchanged(self):
        # Applied twice -- once by the caller, once by the endpoint -- a
        # non-idempotent mapping would grow a second alias and the planner
        # would refuse a field the user really does have.
        from app.xmla.composite_source import to_model_ref

        defn = model()
        once = to_model_ref(defn, "sales.ORDERS.REVENUE")
        assert to_model_ref(defn, once) == once
        assert to_model_ref(defn, "Customer") == "Customer"

    def test_a_question_in_the_builders_dialect_plans_the_same_way(self):
        from app.xmla.composite_source import to_model_refs

        defn = model()
        builder = plan(
            defn,
            dimensions=to_model_refs(defn, ["Customer 360.Customer"]),
            metrics=to_model_refs(
                defn, ["sales.ORDERS.REVENUE", "support.TICKETS.TICKET_COUNT"]
            ),
        )
        native = plan(
            defn,
            dimensions=["Customer"],
            metrics=["sales:ORDERS.REVENUE", "support:TICKETS.TICKET_COUNT"],
        )
        assert [b.alias for b in builder.branches] == [b.alias for b in native.branches]
        assert builder.keys == native.keys
