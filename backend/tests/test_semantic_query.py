import pytest

from app.errors import ApiError
from app.semantic.query import SemanticQueryRequest, build_semantic_sql

DETAIL = {
    "tables": [{"name": "ORDERS"}, {"name": "CUSTOMERS"}],
    "relationships": ["ORDERS_TO_CUSTOMERS"],
    "dimensions": [
        {"table": "ORDERS", "name": "ORDER_DATE", "dataType": "DATE"},
        {"table": "CUSTOMERS", "name": "REGION", "dataType": "VARCHAR(16777216)"},
    ],
    "metrics": [{"table": "ORDERS", "name": "TOTAL_REVENUE", "dataType": "NUMBER(38,2)"}],
    "facts": [],
}


def make_request(**overrides):
    body = {
        "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
        "dimensions": ["ORDERS.ORDER_DATE"], "metrics": ["ORDERS.TOTAL_REVENUE"],
    }
    body.update(overrides)
    return SemanticQueryRequest.model_validate(body)


def test_builds_semantic_view_sql():
    sql, _params, limit = build_semantic_sql(DETAIL, make_request(), max_rows=10000)
    assert limit == 10000
    assert 'SEMANTIC_VIEW(' in sql
    assert '"ANALYTICS"."PUBLIC"."SALES"' in sql
    assert 'DIMENSIONS "ORDERS"."ORDER_DATE"' in sql
    assert 'METRICS "ORDERS"."TOTAL_REVENUE"' in sql
    assert sql.rstrip().endswith("LIMIT 10001")


def test_field_refs_are_case_insensitive_but_canonicalized():
    sql, _params, _ = build_semantic_sql(
        DETAIL, make_request(dimensions=["orders.order_date"]), max_rows=100
    )
    assert '"ORDERS"."ORDER_DATE"' in sql


def test_unknown_field_rejected():
    with pytest.raises(ApiError, match="Unknown"):
        build_semantic_sql(DETAIL, make_request(dimensions=["ORDERS.EVIL"]), max_rows=100)


def test_injection_via_field_name_rejected():
    with pytest.raises(ApiError):
        build_semantic_sql(
            DETAIL, make_request(dimensions=['ORDERS."; DROP TABLE X;--']), max_rows=100
        )


def test_requires_at_least_one_field():
    with pytest.raises(ApiError, match="at least one"):
        build_semantic_sql(DETAIL, make_request(dimensions=[], metrics=[]), max_rows=100)


def test_order_by_must_be_selected_and_limit_clamped():
    req = make_request(orderBy=[{"field": "TOTAL_REVENUE", "direction": "desc"}], limit=50)
    sql, _params, limit = build_semantic_sql(DETAIL, req, max_rows=10000)
    assert 'ORDER BY "TOTAL_REVENUE" DESC' in sql
    assert limit == 50
    assert sql.rstrip().endswith("LIMIT 51")

    bad = make_request(orderBy=[{"field": "REGION"}])
    with pytest.raises(ApiError, match="not selected"):
        build_semantic_sql(DETAIL, bad, max_rows=10000)

    huge = make_request(limit=999999)
    _, _params, limit = build_semantic_sql(DETAIL, huge, max_rows=10000)
    assert limit == 10000


DETAIL_DUPLICATE_NAME = {
    "tables": [{"name": "ORDERS"}, {"name": "CUSTOMERS"}],
    "relationships": ["ORDERS_TO_CUSTOMERS"],
    "dimensions": [
        {"table": "ORDERS", "name": "NAME", "dataType": "VARCHAR(16777216)"},
        {"table": "CUSTOMERS", "name": "NAME", "dataType": "VARCHAR(16777216)"},
        {"table": "ORDERS", "name": "ORDER_DATE", "dataType": "DATE"},
    ],
    "metrics": [],
    "facts": [],
}


def make_dup_request(**overrides):
    body = {
        "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
        "dimensions": ["ORDERS.NAME", "CUSTOMERS.NAME"], "metrics": [],
    }
    body.update(overrides)
    return SemanticQueryRequest.model_validate(body)


def test_order_by_ambiguous_bare_name_rejected():
    req = make_dup_request(orderBy=[{"field": "NAME"}])
    with pytest.raises(ApiError, match="(?i)ambiguous"):
        build_semantic_sql(DETAIL_DUPLICATE_NAME, req, max_rows=10000)


def test_order_by_qualified_ref_disambiguates():
    req = make_dup_request(orderBy=[{"field": "CUSTOMERS.NAME", "direction": "desc"}])
    sql, _params, _ = build_semantic_sql(DETAIL_DUPLICATE_NAME, req, max_rows=10000)
    assert 'ORDER BY "NAME" DESC' in sql


def test_order_by_qualified_ref_must_be_selected():
    req = make_dup_request(orderBy=[{"field": "ORDERS.ORDER_DATE"}])
    with pytest.raises(ApiError, match="not selected"):
        build_semantic_sql(DETAIL_DUPLICATE_NAME, req, max_rows=10000)


DETAIL_NULL_PARENT = {
    "tables": [{"name": "ORDERS"}],
    "relationships": [],
    "dimensions": [
        {"table": "ORDERS", "name": "ORDER_DATE", "dataType": "DATE"},
        {"table": None, "name": "ORPHAN", "dataType": "TEXT"},
    ],
    "metrics": [],
    "facts": [],
}


def test_field_with_null_parent_table_does_not_crash():
    req = SemanticQueryRequest.model_validate(
        {
            "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
            "dimensions": ["ORDERS.ORDER_DATE"], "metrics": [],
        }
    )
    sql, _params, _ = build_semantic_sql(DETAIL_NULL_PARENT, req, max_rows=100)
    assert '"ORDERS"."ORDER_DATE"' in sql

    bad = SemanticQueryRequest.model_validate(
        {
            "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
            "dimensions": ["None.ORPHAN"], "metrics": [],
        }
    )
    with pytest.raises(ApiError):
        build_semantic_sql(DETAIL_NULL_PARENT, bad, max_rows=100)


# --- filters ---------------------------------------------------------------


def test_build_returns_a_three_tuple_with_empty_params_when_unfiltered():
    sql, params, limit = build_semantic_sql(DETAIL, make_request(), max_rows=100)
    assert params == []
    assert limit == 100
    assert "WHERE" not in sql


def test_a_filter_adds_a_where_clause_inside_the_semantic_view_call():
    """Inside the call, not after it: the predicate has to apply before
    aggregation. Verified against a real account by the Task 1 spike."""
    sql, params, _ = build_semantic_sql(
        DETAIL,
        make_request(filters=[
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}
        ]),
        max_rows=100,
    )
    assert sql.index("WHERE") < sql.index("\n)"), "WHERE must sit INSIDE SEMANTIC_VIEW(...)"
    assert params == ["EAST"]


def test_several_filters_are_anded():
    sql, params, _ = build_semantic_sql(
        DETAIL,
        make_request(filters=[
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]},
            {"id": "f2", "field": "ORDERS.ORDER_DATE", "op": "between",
             "from": "2026-01-01", "to": "2026-06-30"},
        ]),
        max_rows=100,
    )
    assert " AND " in sql
    assert params == ["EAST", "2026-01-01", "2026-06-30"]


def test_a_kpi_shaped_query_can_filter_on_an_unselected_dimension():
    """The case the spike existed to prove: metrics only, filtered by a
    dimension that is not among DIMENSIONS, still returning one aggregate."""
    sql, params, _ = build_semantic_sql(
        DETAIL,
        make_request(dimensions=[], filters=[
            {"id": "f1", "field": "CUSTOMERS.REGION", "op": "is", "values": ["EAST"]}
        ]),
        max_rows=100,
    )
    assert "DIMENSIONS" not in sql
    assert '"CUSTOMERS"."REGION"' in sql
    assert params == ["EAST"]


def test_where_precedes_order_by_and_limit():
    sql, _, _ = build_semantic_sql(
        DETAIL,
        make_request(
            filters=[{"id": "f1", "field": "CUSTOMERS.REGION", "op": "is",
                      "values": ["EAST"]}],
            orderBy=[{"field": "TOTAL_REVENUE", "direction": "desc"}],
        ),
        max_rows=100,
    )
    assert sql.index("WHERE") < sql.index("ORDER BY") < sql.index("LIMIT")


def test_relative_dates_resolve_against_the_injected_clock():
    from datetime import date

    _, params, _ = build_semantic_sql(
        DETAIL,
        make_request(filters=[
            {"id": "f1", "field": "ORDERS.ORDER_DATE", "op": "relativeDate",
             "unit": "day", "count": 7}
        ]),
        max_rows=100,
        today=date(2026, 8, 15),
    )
    assert params == [date(2026, 8, 9), date(2026, 8, 15)]


def test_a_filter_on_an_unknown_field_is_rejected():
    with pytest.raises(ApiError):
        build_semantic_sql(
            DETAIL,
            make_request(filters=[
                {"id": "f1", "field": "CUSTOMERS.NOPE", "op": "is", "values": ["X"]}
            ]),
            max_rows=100,
        )
