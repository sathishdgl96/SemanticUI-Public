"""How build_semantic_sql uses the join graph.

Two jobs. Repair what can be repaired -- a dimension-only query across
unrelated entities compiles once a connecting entity is named -- and refuse
what cannot, in a sentence that says which field to drop and what to measure
instead. Snowflake's own three "Invalid dimension specified" errors name
entities, never fields, and offer advice the UI cannot act on.
"""

import pytest

from app.errors import ApiError
from app.semantic.query import SemanticQueryRequest, build_semantic_sql

DETAIL = {
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
    ],
    "facts": [],
}


def request(**overrides):
    body = {"database": "D", "schema": "S", "view": "V", "dimensions": [], "metrics": []}
    body.update(overrides)
    return SemanticQueryRequest.model_validate(body)


class TestBridging:
    def test_unrelated_dimensions_are_joined_through_a_hidden_measure(self):
        sql, _params, _ = build_semantic_sql(
            DETAIL,
            request(dimensions=["PART.BRAND", "SUPPLIER.SUPPLIER_NAME"]),
            max_rows=100,
        )
        # LINEITEMS is the only entity that reaches both. It enters as a
        # METRIC, because a bridging DIMENSION would add rows rather than
        # just a join -- and leaves again in the projection, so the caller
        # gets exactly the two columns it asked for.
        assert 'METRICS "LINEITEMS"."AVG_DISCOUNT"' in sql
        assert 'SELECT * EXCLUDE ("AVG_DISCOUNT")' in sql

    def test_a_query_that_needs_no_bridge_is_untouched(self):
        sql, _params, _ = build_semantic_sql(
            DETAIL,
            request(dimensions=["ORDERS.ORDER_DATE", "CUSTOMERS.CUSTOMER_NAME"]),
            max_rows=100,
        )
        assert sql.startswith("SELECT * FROM SEMANTIC_VIEW(")
        assert "METRICS" not in sql
        assert "EXCLUDE" not in sql

    def test_the_bridge_measure_is_not_orderable(self):
        # It is not in the result set, so ordering by it would fail in
        # Snowflake. Refusing here names the field; Snowflake would not.
        with pytest.raises(ApiError) as excinfo:
            build_semantic_sql(
                DETAIL,
                request(
                    dimensions=["PART.BRAND", "SUPPLIER.SUPPLIER_NAME"],
                    orderBy=[{"field": "LINEITEMS.AVG_DISCOUNT", "direction": "desc"}],
                ),
                max_rows=100,
            )
        assert "not selected" in excinfo.value.message

    def test_it_refuses_rather_than_excluding_a_column_the_user_asked_for(self):
        # A bridge measure whose bare name collides with a selected field
        # would take that field out of the result set with it: EXCLUDE matches
        # by output name, and a semantic view's output names are bare.
        colliding = {
            **DETAIL,
            "metrics": [{"table": "LINEITEMS", "name": "BRAND", "dataType": "NUMBER"}],
        }
        with pytest.raises(ApiError) as excinfo:
            build_semantic_sql(
                colliding,
                request(dimensions=["PART.BRAND", "SUPPLIER.SUPPLIER_NAME"]),
                max_rows=100,
            )
        assert "PART.BRAND" in excinfo.value.message

    def test_it_says_so_when_no_entity_connects_the_selection(self):
        no_metrics = {**DETAIL, "metrics": []}
        with pytest.raises(ApiError) as excinfo:
            build_semantic_sql(
                no_metrics,
                request(dimensions=["PART.BRAND", "SUPPLIER.SUPPLIER_NAME"]),
                max_rows=100,
            )
        message = excinfo.value.message
        assert "PART.BRAND" in message and "SUPPLIER.SUPPLIER_NAME" in message


class TestRefusals:
    def test_a_coarse_measure_cannot_be_broken_down_by_a_finer_field(self):
        with pytest.raises(ApiError) as excinfo:
            build_semantic_sql(
                DETAIL,
                request(dimensions=["ORDERS.ORDER_DATE"], metrics=["CUSTOMERS.CUSTOMER_COUNT"]),
                max_rows=100,
            )
        message = excinfo.value.message
        # Names both halves of the conflict, which Snowflake's own message
        # does not: it says "the dimension entity 'ORDERS'", never the field.
        assert "CUSTOMERS.CUSTOMER_COUNT" in message
        assert "ORDERS.ORDER_DATE" in message
        # And what to do instead, drawn from what this view actually offers.
        assert "LINEITEMS.AVG_DISCOUNT" in message

    def test_the_refusal_is_a_query_error_not_a_server_error(self):
        with pytest.raises(ApiError) as excinfo:
            build_semantic_sql(
                DETAIL,
                request(dimensions=["PART.BRAND"], metrics=["CUSTOMERS.CUSTOMER_COUNT"]),
                max_rows=100,
            )
        assert excinfo.value.status == 400
        assert excinfo.value.code == "QUERY_ERROR"

    def test_a_measure_that_reaches_everything_is_never_refused(self):
        sql, _params, _ = build_semantic_sql(
            DETAIL,
            request(
                dimensions=["PART.BRAND", "REGION.REGION_NAME"],
                metrics=["LINEITEMS.TOTAL_QUANTITY"],
            ),
            max_rows=100,
        )
        assert 'METRICS "LINEITEMS"."TOTAL_QUANTITY"' in sql
        assert "EXCLUDE" not in sql

    def test_a_view_that_declares_no_endpoints_is_left_alone(self):
        # A DESCRIBE cached before relationships carried endpoints. Refusing
        # on the strength of a graph we do not have would break every
        # multi-entity query until the cache expired.
        stale = {**DETAIL, "relationships": ["ORDERS_TO_CUSTOMERS"]}
        sql, _params, _ = build_semantic_sql(
            stale,
            request(dimensions=["PART.BRAND"], metrics=["CUSTOMERS.CUSTOMER_COUNT"]),
            max_rows=100,
        )
        assert 'METRICS "CUSTOMERS"."CUSTOMER_COUNT"' in sql
