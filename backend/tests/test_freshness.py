"""Source freshness: how current the tables under a semantic view are.

The derivation these tests pin down is the whole point of the module.
`LAST_ALTERED` moves on DML, DDL *and* background metadata operations, so on
its own it reports a table as freshly loaded when somebody merely added a
column. Comparing it against `LAST_DDL` -- which only DDL moves -- separates
the two, and that comparison is what must not regress.
"""

from datetime import datetime, timedelta, timezone

from app.semantic.freshness import source_freshness
from tests.fakes import FakeCol, FakeConnection, FakeCursor

INFO_DESC = [
    FakeCol("TABLE_SCHEMA"), FakeCol("TABLE_NAME"), FakeCol("LAST_ALTERED"),
    FakeCol("LAST_DDL"), FakeCol("IS_DYNAMIC"), FakeCol("ROW_COUNT"),
]

LOADED = datetime(2026, 8, 22, 6, 15, tzinfo=timezone.utc)
DEFINED = LOADED - timedelta(days=9)


def table(name: str, base: str | None = "ORDERS_RAW", **over) -> dict:
    """One entry as `describe_semantic_view` reports it."""
    return {
        "name": name,
        "baseDatabase": "SALES" if base else None,
        "baseSchema": "PUBLIC" if base else None,
        "baseTable": base,
        "queryBacked": False,
        **over,
    }


def conn_returning(rows: list[tuple]) -> FakeConnection:
    return FakeConnection(FakeCursor(rows=rows, description=INFO_DESC))


def test_data_changed_more_recently_than_the_definition_reads_as_updated():
    conn = conn_returning([("PUBLIC", "ORDERS_RAW", LOADED, DEFINED, "NO", 42)])

    result = source_freshness(conn, [table("ORDERS")])

    row = result["tables"][0]
    assert row["state"] == "updated"
    assert row["at"] == LOADED
    assert result["oldest"] == LOADED
    assert result["complete"] is True


def test_only_the_definition_changed_never_claims_the_data_did():
    # The failure this exists to prevent: somebody adds a column, LAST_ALTERED
    # jumps to now, and the page tells a reader the data is fresh today.
    conn = conn_returning([("PUBLIC", "ORDERS_RAW", DEFINED, DEFINED, "NO", 42)])

    result = source_freshness(conn, [table("ORDERS")])

    row = result["tables"][0]
    assert row["state"] == "definition-only"
    assert row["at"] == DEFINED
    # No data timestamp, so it cannot contribute to -- or be covered by -- the
    # headline.
    assert result["oldest"] is None
    assert result["complete"] is False


def test_a_table_the_role_cannot_see_is_reported_not_dropped():
    conn = conn_returning([])

    result = source_freshness(conn, [table("ORDERS")])

    assert result["tables"][0]["state"] == "not-visible"
    assert result["complete"] is False


def test_a_query_backed_logical_table_says_so_rather_than_guessing():
    conn = conn_returning([])

    result = source_freshness(
        conn, [table("RECENT", base=None, queryBacked=True)]
    )

    assert result["tables"][0]["state"] == "query-backed"
    assert result["tables"][0]["source"] is None


def test_a_table_with_no_base_properties_is_unresolved():
    conn = conn_returning([])

    result = source_freshness(conn, [table("ORDERS", base=None)])

    assert result["tables"][0]["state"] == "unresolved"


def test_the_headline_is_the_stalest_source():
    # A report is only as current as its oldest input, so the summary takes
    # the minimum rather than the most recent.
    older = LOADED - timedelta(days=3)
    conn = conn_returning([
        ("PUBLIC", "ORDERS_RAW", LOADED, DEFINED, "NO", 42),
        ("PUBLIC", "CUSTOMERS_RAW", older, DEFINED, "NO", 7),
    ])

    result = source_freshness(
        conn,
        [table("ORDERS"), table("CUSTOMERS", base="CUSTOMERS_RAW")],
    )

    assert result["oldest"] == older
    assert result["complete"] is True


def test_a_dynamic_source_is_flagged():
    # v1 only marks it: the better answer needs DYNAMIC_TABLE_REFRESH_HISTORY,
    # which requires MONITOR that an analyst role will not hold.
    conn = conn_returning([("PUBLIC", "ORDERS_RAW", LOADED, DEFINED, "YES", 42)])

    result = source_freshness(conn, [table("ORDERS")])

    assert result["tables"][0]["isDynamic"] is True


def test_one_statement_per_database_not_one_per_table():
    # The constant-query property every listing in this product holds.
    conn = conn_returning([("PUBLIC", "ORDERS_RAW", LOADED, DEFINED, "NO", 1)])

    source_freshness(
        conn,
        [
            table("ORDERS"),
            table("CUSTOMERS", base="CUSTOMERS_RAW"),
            table("ITEMS", base="ITEMS_RAW"),
        ],
    )

    assert len(conn.cursor().executed) == 1


def test_a_failing_query_leaves_the_block_unavailable_rather_than_raising():
    # The About page must still render its other blocks.
    conn = FakeConnection(
        FakeCursor(description=INFO_DESC, error=RuntimeError("no warehouse"))
    )

    result = source_freshness(conn, [table("ORDERS")])

    assert result["available"] is False
    assert result["oldest"] is None
