import pytest

from app.errors import ApiError
from app.semantic.discovery import (
    describe_semantic_view,
    list_semantic_views,
    quote_ident,
)
from tests.fakes import FakeCol, FakeConnection, FakeCursor


def test_quote_ident():
    assert quote_ident("MY_VIEW") == '"MY_VIEW"'
    with pytest.raises(ApiError):
        quote_ident('EVIL"NAME')


SHOW_DESC = [
    FakeCol("created_on"), FakeCol("name"), FakeCol("database_name"),
    FakeCol("schema_name"), FakeCol("comment"),
]


def test_list_semantic_views_scoping():
    cur = FakeCursor(
        rows=[("2026-01-01", "SALES", "ANALYTICS", "PUBLIC", "sales model")],
        description=SHOW_DESC,
    )
    conn = FakeConnection(cur)
    views = list_semantic_views(conn, database="ANALYTICS", schema="PUBLIC")
    assert cur.executed == ['SHOW SEMANTIC VIEWS IN SCHEMA "ANALYTICS"."PUBLIC"']
    assert views == [
        {"name": "SALES", "database": "ANALYTICS", "schema": "PUBLIC", "comment": "sales model"}
    ]

    list_semantic_views(conn, database="ANALYTICS")
    assert cur.executed[-1] == 'SHOW SEMANTIC VIEWS IN DATABASE "ANALYTICS"'
    list_semantic_views(conn)
    assert cur.executed[-1] == "SHOW SEMANTIC VIEWS IN ACCOUNT"


DESCRIBE_DESC = [
    FakeCol("object_kind"), FakeCol("object_name"), FakeCol("parent_entity"),
    FakeCol("property"), FakeCol("property_value"),
]

DESCRIBE_ROWS = [
    ("TABLE", "ORDERS", None, None, None),
    ("TABLE", "CUSTOMERS", None, None, None),
    ("RELATIONSHIP", "ORDERS_TO_CUSTOMERS", None, None, None),
    ("DIMENSION", "ORDER_DATE", "ORDERS", "DATA_TYPE", "DATE"),
    ("DIMENSION", "ORDER_DATE", "ORDERS", "EXPRESSION", "o_orderdate"),
    ("DIMENSION", "REGION", "CUSTOMERS", "DATA_TYPE", "VARCHAR(16777216)"),
    ("METRIC", "TOTAL_REVENUE", "ORDERS", "DATA_TYPE", "NUMBER(38,2)"),
    ("FACT", "ORDER_AMOUNT", "ORDERS", "DATA_TYPE", "NUMBER(38,2)"),
]


def test_describe_semantic_view_parses_shape():
    cur = FakeCursor(rows=DESCRIBE_ROWS, description=DESCRIBE_DESC)
    conn = FakeConnection(cur)
    detail = describe_semantic_view(conn, "ANALYTICS", "PUBLIC", "SALES")
    assert cur.executed == ['DESCRIBE SEMANTIC VIEW "ANALYTICS"."PUBLIC"."SALES"']
    assert detail["tables"] == [{"name": "ORDERS"}, {"name": "CUSTOMERS"}]
    assert detail["relationships"] == ["ORDERS_TO_CUSTOMERS"]
    assert detail["dimensions"] == [
        {"table": "ORDERS", "name": "ORDER_DATE", "dataType": "DATE"},
        {"table": "CUSTOMERS", "name": "REGION", "dataType": "VARCHAR(16777216)"},
    ]
    assert detail["metrics"] == [
        {"table": "ORDERS", "name": "TOTAL_REVENUE", "dataType": "NUMBER(38,2)"}
    ]
    assert detail["facts"] == [
        {"table": "ORDERS", "name": "ORDER_AMOUNT", "dataType": "NUMBER(38,2)"}
    ]
