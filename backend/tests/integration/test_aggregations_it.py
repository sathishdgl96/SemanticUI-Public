"""Do ad-hoc aggregations actually run on Snowflake?

The unit tests prove the SQL we BUILD. Only a real account proves the
FACTS clause and the outer GROUP BY are grammar Snowflake accepts, and that
the numbers are the ones a person would expect.

    pytest tests/integration/test_aggregations_it.py -v -s -m integration
"""

import os

import pytest
import snowflake.connector

from app.semantic.discovery import describe_semantic_view
from app.semantic.query import SemanticQueryRequest, build_semantic_sql
from app.snowflake import connect as sf_connect

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.environ.get("SEMANTICUI_IT_ACCOUNT"),
        reason="SEMANTICUI_IT_* env vars not set",
    ),
]


@pytest.fixture(scope="module")
def conn():
    connection = snowflake.connector.connect(
        account=sf_connect.normalize_account(os.environ["SEMANTICUI_IT_ACCOUNT"]),
        user=os.environ["SEMANTICUI_IT_USER"],
        password=os.environ["SEMANTICUI_IT_PASSWORD"],
        paramstyle="qmark",
    )
    yield connection
    connection.close()


@pytest.fixture(scope="module")
def view():
    return (
        os.environ["SEMANTICUI_IT_DATABASE"],
        os.environ["SEMANTICUI_IT_SCHEMA"],
        os.environ["SEMANTICUI_IT_VIEW"],
    )


@pytest.fixture(scope="module")
def detail(conn, view):
    return describe_semantic_view(conn, *view)


@pytest.fixture(scope="module")
def a_fact(detail):
    if not detail.get("facts"):
        pytest.skip("no facts in this view")
    f = detail["facts"][0]
    return f"{f['table']}.{f['name']}"


@pytest.fixture(scope="module")
def a_dimension(detail, a_fact):
    """A dimension from the FACT's own table.

    Snowflake refuses a query that names both FACTS and DIMENSIONS from
    different entities, so pairing them arbitrarily would test a combination
    the API is right to reject. Discovered by running it -- the first version
    of this fixture took dimensions[0] and passed only because that field
    happened to share a table with facts[0]."""
    table = a_fact.split(".")[0]
    same = [d for d in detail["dimensions"] if d["table"] == table]
    if not same:
        pytest.skip(f"no dimension on {table} to group by")
    return f"{same[0]['table']}.{same[0]['name']}"


@pytest.fixture(scope="module")
def a_foreign_dimension(detail, a_fact):
    """A dimension from a DIFFERENT table than the fact."""
    table = a_fact.split(".")[0]
    other = [d for d in detail["dimensions"] if d["table"] != table]
    if not other:
        pytest.skip("this view has only one entity")
    return f"{other[0]['table']}.{other[0]['name']}"


def run(conn, view, detail, **payload):
    request = SemanticQueryRequest(
        database=view[0], schema=view[1], view=view[2], limit=20, **payload
    )
    sql, params, _ = build_semantic_sql(detail, request, max_rows=20)
    print("\nSQL:", sql)
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
    print("ROWS:", rows[:3])
    return rows


def test_sum_of_a_fact_by_a_dimension(conn, view, detail, a_fact, a_dimension):
    rows = run(
        conn, view, detail,
        dimensions=[a_dimension],
        aggregations=[{"field": a_fact, "fn": "sum"}],
    )
    assert rows, "no rows came back"
    assert len(rows[0]) == 2


@pytest.mark.parametrize("fn", ["sum", "avg", "min", "max", "count", "countDistinct"])
def test_every_function_runs(conn, view, detail, a_fact, a_dimension, fn):
    rows = run(
        conn, view, detail,
        dimensions=[a_dimension],
        aggregations=[{"field": a_fact, "fn": fn}],
    )
    assert rows


def test_an_aggregate_with_no_dimension_returns_one_row(conn, view, detail, a_fact):
    rows = run(conn, view, detail, aggregations=[{"field": a_fact, "fn": "sum"}])
    assert len(rows) == 1


def test_min_is_at_most_max(conn, view, detail, a_fact, a_dimension):
    """A sanity check on the NUMBERS, not just the grammar: a query that runs
    but returns nonsense is the failure mode a syntax test cannot see."""
    lo = run(conn, view, detail, aggregations=[{"field": a_fact, "fn": "min"}])[0][0]
    hi = run(conn, view, detail, aggregations=[{"field": a_fact, "fn": "max"}])[0][0]
    print("min:", lo, "max:", hi)
    assert lo <= hi


def test_a_filtered_aggregate_is_no_larger_than_an_unfiltered_one(
    conn, view, detail, a_fact, a_dimension
):
    """The filter has to apply BEFORE aggregation, inside the call. If it
    leaked outside, the total would not move."""
    total = run(conn, view, detail, aggregations=[{"field": a_fact, "fn": "count"}])[0][0]
    values = run(conn, view, detail, dimensions=[a_dimension])
    one = str(values[0][0])
    filtered = run(
        conn, view, detail,
        aggregations=[{"field": a_fact, "fn": "count"}],
        filters=[{"id": "f1", "field": a_dimension, "op": "is", "values": [one]}],
    )[0][0]
    print("total:", total, "filtered:", filtered)
    assert filtered <= total


def test_ordering_by_the_aggregate_runs(conn, view, detail, a_fact, a_dimension):
    rows = run(
        conn, view, detail,
        dimensions=[a_dimension],
        aggregations=[{"field": a_fact, "fn": "sum"}],
        orderBy=[{"field": a_fact, "direction": "desc"}],
    )
    assert rows
    # Descending means descending.
    values = [r[1] for r in rows if r[1] is not None]
    assert values == sorted(values, reverse=True)


def test_a_fact_grouped_across_entities_is_refused_before_snowflake_sees_it(
    conn, view, detail, a_fact, a_foreign_dimension
):
    """Snowflake rejects this with a message that names no field. Ours has to
    say which table to group by instead."""
    from app.errors import ApiError

    with pytest.raises(ApiError) as exc:
        run(
            conn, view, detail,
            dimensions=[a_foreign_dimension],
            aggregations=[{"field": a_fact, "fn": "sum"}],
        )
    assert "own table" in exc.value.message
    assert a_fact.split(".")[0] in exc.value.message
