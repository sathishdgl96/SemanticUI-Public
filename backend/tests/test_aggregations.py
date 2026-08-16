"""Ad-hoc aggregation over raw FACT columns.

PowerBI's habit -- drop any numeric field into Values and pick Sum or
Average -- expressed over a semantic view. The view's own METRICS stay the
governed way to measure; this is the escape hatch.
"""

import pytest

from app.errors import ApiError
from app.semantic.query import SemanticQueryRequest, build_semantic_sql

DETAIL = {
    "dimensions": [{"table": "CUSTOMERS", "name": "REGION"}],
    "facts": [
        {"table": "CUSTOMERS", "name": "BALANCE"},
        {"table": "CUSTOMERS", "name": "CREDIT"},
        {"table": "ORDERS", "name": "QUANTITY"},
    ],
    "metrics": [{"table": "ORDERS", "name": "REVENUE"}],
}


def build(**payload):
    request = SemanticQueryRequest(
        database="D", schema="S", view="V", **payload
    )
    return build_semantic_sql(DETAIL, request, max_rows=100)


def test_a_query_without_aggregations_is_unchanged():
    """The feature must not alter the shape of a query that does not use it."""
    sql, _, _ = build(dimensions=["CUSTOMERS.REGION"], metrics=["ORDERS.REVENUE"])
    assert sql.startswith("SELECT * FROM SEMANTIC_VIEW(")
    assert "GROUP BY" not in sql
    assert "FACTS" not in sql


def test_a_fact_is_selected_through_the_facts_clause():
    # Verified against a real account: FACTS is its own clause, and facts
    # come back row-level for the outer SELECT to aggregate.
    sql, _, _ = build(
        dimensions=["CUSTOMERS.REGION"],
        aggregations=[{"field": "CUSTOMERS.BALANCE", "fn": "sum"}],
    )
    assert 'FACTS "CUSTOMERS"."BALANCE"' in sql
    assert 'DIMENSIONS "CUSTOMERS"."REGION"' in sql


def test_the_aggregate_is_grouped_by_every_dimension():
    sql, _, _ = build(
        dimensions=["CUSTOMERS.REGION"],
        aggregations=[{"field": "CUSTOMERS.BALANCE", "fn": "sum"}],
    )
    assert 'SELECT "REGION", SUM("BALANCE") AS "BALANCE"' in sql
    assert 'GROUP BY "REGION"' in sql


def test_the_aggregate_keeps_the_fields_own_name():
    """Aliased back to the bare field name so every renderer keeps working
    without knowing an aggregation happened."""
    sql, _, _ = build(aggregations=[{"field": "CUSTOMERS.BALANCE", "fn": "avg"}])
    assert 'AVG("BALANCE") AS "BALANCE"' in sql


@pytest.mark.parametrize(
    "fn,expected",
    [
        ("sum", 'SUM("BALANCE")'),
        ("avg", 'AVG("BALANCE")'),
        ("min", 'MIN("BALANCE")'),
        ("max", 'MAX("BALANCE")'),
        ("count", 'COUNT("BALANCE")'),
        ("countDistinct", 'COUNT(DISTINCT "BALANCE")'),
    ],
)
def test_every_function_emits_its_own_sql(fn, expected):
    sql, _, _ = build(aggregations=[{"field": "CUSTOMERS.BALANCE", "fn": fn}])
    assert expected in sql


def test_an_unknown_function_is_refused_by_the_model():
    # The function name is never taken from input -- it selects a fixed
    # template -- but the union should refuse it long before that matters.
    with pytest.raises(Exception):
        build(aggregations=[{"field": "CUSTOMERS.BALANCE", "fn": "median; DROP"}])


def test_an_aggregation_over_something_that_is_not_a_fact_is_refused():
    with pytest.raises(ApiError) as exc:
        build(aggregations=[{"field": "CUSTOMERS.REGION", "fn": "sum"}])
    assert "fact" in exc.value.message.lower()

    with pytest.raises(ApiError):
        build(aggregations=[{"field": "CUSTOMERS.GHOST", "fn": "sum"}])


def test_metrics_and_aggregations_cannot_be_mixed():
    """A metric is aggregated by the model; a fact is row-level. Selecting
    both would repeat the metric down every raw row -- a wrong number that
    looks like a right one."""
    with pytest.raises(ApiError) as exc:
        build(
            dimensions=["CUSTOMERS.REGION"],
            metrics=["ORDERS.REVENUE"],
            aggregations=[{"field": "CUSTOMERS.BALANCE", "fn": "sum"}],
        )
    assert "grain" in exc.value.message.lower()


def test_an_aggregation_with_no_dimension_needs_no_group_by():
    # A card showing one number over the whole view.
    sql, _, _ = build(aggregations=[{"field": "CUSTOMERS.BALANCE", "fn": "sum"}])
    assert "GROUP BY" not in sql
    assert 'SUM("BALANCE")' in sql


def test_several_aggregations_pair_with_their_own_fields():
    sql, _, _ = build(
        dimensions=["CUSTOMERS.REGION"],
        aggregations=[
            {"field": "CUSTOMERS.BALANCE", "fn": "sum"},
            {"field": "CUSTOMERS.CREDIT", "fn": "avg"},
        ],
    )
    # Pairing is positional; a crossed pair would aggregate the wrong column
    # with the right name, which no error would ever surface.
    assert 'SUM("BALANCE") AS "BALANCE"' in sql
    assert 'AVG("CREDIT") AS "CREDIT"' in sql


def test_filters_still_apply_inside_the_semantic_view():
    """The predicate must stay INSIDE the call, before aggregation."""
    sql, params, _ = build(
        dimensions=["CUSTOMERS.REGION"],
        aggregations=[{"field": "CUSTOMERS.BALANCE", "fn": "sum"}],
        filters=[
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}
        ],
    )
    where_at = sql.index("WHERE")
    close_at = sql.index("\n)")
    assert where_at < close_at, "WHERE escaped the SEMANTIC_VIEW call"
    assert params == ["EAST"]
    assert "EAST" not in sql


def test_ordering_by_an_aggregated_field_is_allowed():
    sql, _, _ = build(
        dimensions=["CUSTOMERS.REGION"],
        aggregations=[{"field": "CUSTOMERS.BALANCE", "fn": "sum"}],
        orderBy=[{"field": "CUSTOMERS.BALANCE", "direction": "desc"}],
    )
    assert 'ORDER BY "BALANCE" DESC' in sql


def test_a_fact_may_only_be_grouped_by_its_own_table():
    """Snowflake's rule, found by running it: "All expressions referenced in
    the query must come from the same entity when both FACTS and DIMENSIONS
    are specified." A raw fact carries no join path -- only the model's
    metrics do."""
    detail = {
        "dimensions": [
            {"table": "CUSTOMERS", "name": "REGION"},
            {"table": "ORDERS", "name": "STATUS"},
        ],
        "facts": [{"table": "ORDERS", "name": "TOTAL"}],
        "metrics": [],
    }
    request = SemanticQueryRequest(
        database="D", schema="S", view="V",
        dimensions=["CUSTOMERS.REGION"],
        aggregations=[{"field": "ORDERS.TOTAL", "fn": "sum"}],
    )
    with pytest.raises(ApiError) as exc:
        build_semantic_sql(detail, request, max_rows=100)
    # The message has to name the table to group by; Snowflake's own does
    # not name the offending fields at all.
    assert "ORDERS" in exc.value.message
    assert "own table" in exc.value.message


def test_a_fact_grouped_by_its_own_table_is_allowed():
    detail = {
        "dimensions": [{"table": "ORDERS", "name": "STATUS"}],
        "facts": [{"table": "ORDERS", "name": "TOTAL"}],
        "metrics": [],
    }
    request = SemanticQueryRequest(
        database="D", schema="S", view="V",
        dimensions=["ORDERS.STATUS"],
        aggregations=[{"field": "ORDERS.TOTAL", "fn": "sum"}],
    )
    sql, _, _ = build_semantic_sql(detail, request, max_rows=100)
    assert 'GROUP BY "STATUS"' in sql


def test_an_aggregate_with_no_dimension_spans_any_table():
    # The rule only bites when both clauses are present.
    detail = {
        "dimensions": [{"table": "CUSTOMERS", "name": "REGION"}],
        "facts": [{"table": "ORDERS", "name": "TOTAL"}],
        "metrics": [],
    }
    request = SemanticQueryRequest(
        database="D", schema="S", view="V",
        aggregations=[{"field": "ORDERS.TOTAL", "fn": "sum"}],
    )
    sql, _, _ = build_semantic_sql(detail, request, max_rows=100)
    assert 'SUM("TOTAL")' in sql
