import pytest

from app.errors import ApiError
from app.semantic.discovery import (
    describe_semantic_view,
    detect_hierarchies,
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
        {
            "name": "SALES", "database": "ANALYTICS", "schema": "PUBLIC",
            "comment": "sales model",
            # This fixture predates the owner columns, so both read as unknown.
            "owner": None, "ownerRoleType": None,
        }
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
    ("RELATIONSHIP", "ORDERS_TO_CUSTOMERS", "ORDERS", "TABLE", "ORDERS"),
    ("RELATIONSHIP", "ORDERS_TO_CUSTOMERS", "ORDERS", "REF_TABLE", "CUSTOMERS"),
    ("RELATIONSHIP", "ORDERS_TO_CUSTOMERS", "ORDERS", "FOREIGN_KEY", '["O_CUSTKEY"]'),
    ("DIMENSION", "ORDER_DATE", "ORDERS", "DATA_TYPE", "DATE"),
    ("DIMENSION", "ORDER_DATE", "ORDERS", "EXPRESSION", "o_orderdate"),
    ("DIMENSION", "REGION", "CUSTOMERS", "DATA_TYPE", "VARCHAR(16777216)"),
    ("METRIC", "TOTAL_REVENUE", "ORDERS", "DATA_TYPE", "NUMBER(38,2)"),
    ("FACT", "ORDER_AMOUNT", "ORDERS", "DATA_TYPE", "NUMBER(38,2)"),
]


def test_execute_dicts_bounds_fetch_by_configured_row_cap(monkeypatch):
    # SHOW/DESCRIBE go through _execute_dicts, which previously called
    # fetchall() with no cap at all -- bypassing the gateway's row_cap
    # entirely for these statement kinds.
    from app.config import get_settings

    monkeypatch.setenv("SEMANTICUI_ROW_CAP", "2")
    get_settings.cache_clear()
    try:
        cur = FakeCursor(
            rows=[
                (f"2026-01-0{i}", f"VIEW_{i}", "ANALYTICS", "PUBLIC", None)
                for i in range(1, 6)
            ],
            description=SHOW_DESC,
        )
        conn = FakeConnection(cur)
        views = list_semantic_views(conn)
        assert len(views) == 2
    finally:
        get_settings.cache_clear()


def test_describe_semantic_view_parses_shape():
    cur = FakeCursor(rows=DESCRIBE_ROWS, description=DESCRIBE_DESC)
    conn = FakeConnection(cur)
    detail = describe_semantic_view(conn, "ANALYTICS", "PUBLIC", "SALES")
    assert cur.executed == ['DESCRIBE SEMANTIC VIEW "ANALYTICS"."PUBLIC"."SALES"']
    # These rows carry no BASE_TABLE_* properties, so both tables are present
    # in the model and unresolved as sources -- which is what freshness must
    # report rather than dropping them.
    unresolved = {
        "baseDatabase": None, "baseSchema": None, "baseTable": None,
        "queryBacked": False,
    }
    assert detail["tables"] == [
        {"name": "ORDERS", **unresolved},
        {"name": "CUSTOMERS", **unresolved},
    ]
    # The endpoints, not just the name: they are the only description of the
    # join graph Snowflake gives us, and without them a query across two
    # entities can only be checked by running it and reading the error.
    assert detail["relationships"] == [
        {
            "name": "ORDERS_TO_CUSTOMERS",
            "table": "ORDERS",
            "refTable": "CUSTOMERS",
            # The columns the join is ON. This fixture has no REF_KEY row,
            # so that side is empty rather than missing.
            "foreignKey": ["O_CUSTKEY"],
            "refKey": [],
        }
    ]
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


# --- model-declared hierarchies --------------------------------------------

HIERARCHY_ROWS = DESCRIBE_ROWS + [
    ("HIERARCHY", "GEOGRAPHY", "CUSTOMERS", "LEVELS", "COUNTRY, STATE, CITY"),
]


def _detail(rows):
    cur = FakeCursor(rows=list(rows), description=DESCRIBE_DESC)
    return describe_semantic_view(FakeConnection(cur), "D", "S", "V")


def test_describe_reports_no_hierarchies_on_todays_accounts():
    """Snowflake does not expose hierarchies in DESCRIBE on the account this
    was built against. An empty list -- not a missing key -- is what lets the
    report-defined path work unchanged."""
    assert _detail(DESCRIBE_ROWS)["hierarchies"] == []


def test_detect_hierarchies_finds_nothing_in_todays_output():
    assert detect_hierarchies(_detail(DESCRIBE_ROWS)) == []


def test_detect_hierarchies_reads_a_hierarchy_shaped_object():
    assert detect_hierarchies(_detail(HIERARCHY_ROWS)) == [
        {
            "id": "model:CUSTOMERS.GEOGRAPHY",
            "name": "GEOGRAPHY",
            "levels": ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY"],
        }
    ]


def test_detect_hierarchies_skips_one_level_objects():
    """A one-level hierarchy is a plain field; surfacing it as drillable would
    offer a drill that immediately dead-ends."""
    rows = DESCRIBE_ROWS + [("HIERARCHY", "SOLO", "CUSTOMERS", "LEVELS", "COUNTRY")]
    assert detect_hierarchies(_detail(rows)) == []


def test_detect_hierarchies_tolerates_a_hierarchy_with_no_levels_property():
    rows = DESCRIBE_ROWS + [("HIERARCHY", "EMPTY", "CUSTOMERS", "COMMENT", "hi")]
    assert detect_hierarchies(_detail(rows)) == []


def test_relationships_carry_their_join_columns():
    """FOREIGN_KEY / REF_KEY are the only statement of WHICH columns join.

    Snowflake reports them as JSON arrays and the parser used to drop
    them, so the model diagram could say that two tables are joined but
    never on what -- the first question anyone asks of a data model.
    """
    from app.semantic.discovery import describe_semantic_view

    rows = list(DESCRIBE_ROWS) + [
        ("RELATIONSHIP", "ORDERS_TO_CUSTOMERS", "ORDERS", "REF_KEY", '["C_CUSTKEY"]'),
    ]
    conn = FakeConnection(FakeCursor(rows=rows, description=DESCRIBE_DESC))
    detail = describe_semantic_view(conn, "DB", "SCHEMA", "VIEW")

    assert detail["relationships"] == [
        {
            "name": "ORDERS_TO_CUSTOMERS",
            "table": "ORDERS",
            "refTable": "CUSTOMERS",
            "foreignKey": ["O_CUSTKEY"],
            "refKey": ["C_CUSTKEY"],
        }
    ]


def test_a_relationship_with_unreadable_keys_still_parses():
    """A key list that is not the JSON array Snowflake documents must not
    take the whole describe down -- the join still exists."""
    from app.semantic.discovery import describe_semantic_view

    rows = [
        ("TABLE", "A", None, None, None),
        ("TABLE", "B", None, None, None),
        ("RELATIONSHIP", "A_TO_B", "A", "TABLE", "A"),
        ("RELATIONSHIP", "A_TO_B", "A", "REF_TABLE", "B"),
        ("RELATIONSHIP", "A_TO_B", "A", "FOREIGN_KEY", "not-json"),
    ]
    conn = FakeConnection(FakeCursor(rows=rows, description=DESCRIBE_DESC))
    detail = describe_semantic_view(conn, "DB", "SCHEMA", "VIEW")
    assert detail["relationships"][0]["foreignKey"] == []
    assert detail["relationships"][0]["refKey"] == []


# --- Ownership and base tables: both already on the wire, both discarded ---
# until model certification and source freshness needed them. See
# docs/superpowers/specs/2026-08-22-model-trust-and-provenance-design.md.

SHOW_DESC_WITH_OWNER = [
    FakeCol("created_on"), FakeCol("name"), FakeCol("database_name"),
    FakeCol("schema_name"), FakeCol("comment"), FakeCol("owner"),
    FakeCol("owner_role_type"),
]


def test_list_semantic_views_carries_owner_and_role_type():
    # Certification authority is Snowflake's answer, not the app's, and this
    # is the only place the owning role is named.
    cur = FakeCursor(
        rows=[(
            "2026-01-01", "SALES", "ANALYTICS", "PUBLIC", "sales model",
            "DATA_ENG", "ROLE",
        )],
        description=SHOW_DESC_WITH_OWNER,
    )
    views = list_semantic_views(FakeConnection(cur))

    assert views[0]["owner"] == "DATA_ENG"
    assert views[0]["ownerRoleType"] == "ROLE"


def test_list_semantic_views_without_owner_columns_reports_none():
    # Older accounts, and the TERSE form, do not return the column at all.
    # An absent owner must read as "unknown", never as an empty role name
    # that would then be handed to IS_ROLE_IN_SESSION.
    cur = FakeCursor(
        rows=[("2026-01-01", "SALES", "ANALYTICS", "PUBLIC", None)],
        description=SHOW_DESC,
    )
    views = list_semantic_views(FakeConnection(cur))

    assert views[0]["owner"] is None
    assert views[0]["ownerRoleType"] is None


DESCRIBE_ROWS_WITH_BASE = [
    ("TABLE", "ORDERS", None, "BASE_TABLE_DATABASE_NAME", "SALES"),
    ("TABLE", "ORDERS", None, "BASE_TABLE_SCHEMA_NAME", "PUBLIC"),
    ("TABLE", "ORDERS", None, "BASE_TABLE_NAME", "ORDERS_RAW"),
    ("TABLE", "RECENT", None, "DEFINITION", "SELECT * FROM ORDERS_RAW"),
    ("DIMENSION", "ORDER_DATE", "ORDERS", "DATA_TYPE", "DATE"),
]


def test_describe_semantic_view_resolves_the_physical_base_table():
    # The logical name is what the model calls it; freshness has to ask
    # INFORMATION_SCHEMA about the physical one.
    cur = FakeCursor(rows=DESCRIBE_ROWS_WITH_BASE, description=DESCRIBE_DESC)
    detail = describe_semantic_view(FakeConnection(cur), "SALES", "PUBLIC", "V")

    orders = next(t for t in detail["tables"] if t["name"] == "ORDERS")
    assert orders["baseDatabase"] == "SALES"
    assert orders["baseSchema"] == "PUBLIC"
    assert orders["baseTable"] == "ORDERS_RAW"


def test_describe_semantic_view_marks_a_query_backed_logical_table():
    # A logical table defined by a SQL query has no single source table, so
    # freshness must say so rather than guess at one.
    cur = FakeCursor(rows=DESCRIBE_ROWS_WITH_BASE, description=DESCRIBE_DESC)
    detail = describe_semantic_view(FakeConnection(cur), "SALES", "PUBLIC", "V")

    recent = next(t for t in detail["tables"] if t["name"] == "RECENT")
    assert recent["queryBacked"] is True
    assert recent["baseTable"] is None


def test_describe_semantic_view_table_without_base_properties_is_unresolved():
    # The properties are optional on the wire; a table we cannot resolve is
    # reported as unresolved rather than dropped from the model.
    cur = FakeCursor(rows=DESCRIBE_ROWS, description=DESCRIBE_DESC)
    detail = describe_semantic_view(FakeConnection(cur), "SALES", "PUBLIC", "V")

    orders = next(t for t in detail["tables"] if t["name"] == "ORDERS")
    assert orders["baseTable"] is None
    assert orders["queryBacked"] is False
