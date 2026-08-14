import pytest

from app.errors import ApiError
from app.semantic.query import OrderBy, SemanticQueryRequest, build_semantic_sql

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
    sql, limit = build_semantic_sql(DETAIL, make_request(), max_rows=10000)
    assert limit == 10000
    assert 'SEMANTIC_VIEW(' in sql
    assert '"ANALYTICS"."PUBLIC"."SALES"' in sql
    assert 'DIMENSIONS "ORDERS"."ORDER_DATE"' in sql
    assert 'METRICS "ORDERS"."TOTAL_REVENUE"' in sql
    assert sql.rstrip().endswith("LIMIT 10001")


def test_field_refs_are_case_insensitive_but_canonicalized():
    sql, _ = build_semantic_sql(
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
    sql, limit = build_semantic_sql(DETAIL, req, max_rows=10000)
    assert 'ORDER BY "TOTAL_REVENUE" DESC' in sql
    assert limit == 50
    assert sql.rstrip().endswith("LIMIT 51")

    bad = make_request(orderBy=[{"field": "REGION"}])
    with pytest.raises(ApiError, match="not selected"):
        build_semantic_sql(DETAIL, bad, max_rows=10000)

    huge = make_request(limit=999999)
    _, limit = build_semantic_sql(DETAIL, huge, max_rows=10000)
    assert limit == 10000
