"""Do the wider filter operators actually run on Snowflake?

Unit tests prove the SQL we BUILD; only a real account proves Snowflake
accepts it. Two things in particular cannot be checked any other way:

  - LIKE ... ESCAPE inside a SEMANTIC_VIEW() call. The escape clause is
    quoted SQL text, and the spike showed this grammar is fussier than the
    plain WHERE it looks like.
  - That the escaping actually WORKS -- a user's "%" matching literally
    rather than as a wildcard. A filter that silently returns more rows than
    the person asked for is a wrong answer that looks like a right one, and
    that is precisely the failure a unit test on a string cannot catch.

Run with:

    pytest tests/integration/test_filter_operators_it.py -v -s -m integration
"""

import os

import pytest
import snowflake.connector

from app.reports.filters import Filter
from app.semantic.discovery import describe_semantic_view
from app.semantic.query import SemanticQueryRequest, build_semantic_sql
from app.snowflake import connect as sf_connect
from pydantic import TypeAdapter

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.environ.get("SEMANTICUI_IT_ACCOUNT"),
        reason="SEMANTICUI_IT_* env vars not set",
    ),
]

ADAPTER = TypeAdapter(Filter)


@pytest.fixture(scope="module")
def conn():
    # qmark, not the connector default: see test_filter_spike_it.py.
    connection = snowflake.connector.connect(
        account=sf_connect.normalize_account(os.environ["SEMANTICUI_IT_ACCOUNT"]),
        user=os.environ["SEMANTICUI_IT_USER"],
        password=os.environ["SEMANTICUI_IT_PASSWORD"],
        paramstyle="qmark",
    )
    yield connection
    connection.close()


@pytest.fixture(scope="module")
def view(conn):
    return (
        os.environ["SEMANTICUI_IT_DATABASE"],
        os.environ["SEMANTICUI_IT_SCHEMA"],
        os.environ["SEMANTICUI_IT_VIEW"],
    )


@pytest.fixture(scope="module")
def detail(conn, view):
    return describe_semantic_view(conn, *view)


@pytest.fixture(scope="module")
def text_field(detail):
    """A dimension whose type is textual -- the one substring matching needs."""
    for d in detail["dimensions"]:
        if "CHAR" in (d.get("dataType") or "").upper():
            return f"{d['table']}.{d['name']}"
    pytest.skip("no text dimension in this view")


@pytest.fixture(scope="module")
def a_metric(detail):
    m = detail["metrics"][0]
    return f"{m['table']}.{m['name']}"


def run(conn, view, detail, a_metric, filters, dimensions=None):
    request = SemanticQueryRequest(
        database=view[0],
        schema=view[1],
        view=view[2],
        dimensions=dimensions or [],
        metrics=[a_metric],
        filters=filters,
        limit=50,
    )
    sql, params, _ = build_semantic_sql(detail, request, max_rows=50)
    print("\nSQL:", sql)
    print("PARAMS:", params)
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def f(**payload):
    return ADAPTER.validate_python({"id": "f1", **payload})


def test_contains_runs(conn, view, detail, a_metric, text_field):
    rows = run(conn, view, detail, a_metric, [f(field=text_field, op="contains", value="a")])
    print("contains ->", rows)
    assert rows is not None


def test_starts_and_ends_with_run(conn, view, detail, a_metric, text_field):
    for op in ("startsWith", "endsWith"):
        rows = run(conn, view, detail, a_metric, [f(field=text_field, op=op, value="A")])
        print(op, "->", rows)
        assert rows is not None


def test_escaping_makes_a_percent_match_literally(
    conn, view, detail, a_metric, text_field
):
    """The invariant that matters: "%" typed by a user is a character, not a
    wildcard. Unescaped, this filter would match every row."""
    literal = run(
        conn, view, detail, a_metric, [f(field=text_field, op="contains", value="%")]
    )
    unfiltered = run(conn, view, detail, a_metric, [])
    print("literal % ->", literal)
    print("unfiltered ->", unfiltered)
    # If escaping were broken, "%" would be a wildcard and these would agree.
    assert literal != unfiltered or not unfiltered, (
        "a literal % matched everything -- the ESCAPE clause is not working"
    )


def test_comparison_operators_run(conn, view, detail, a_metric):
    facts = detail.get("facts") or []
    if not facts:
        pytest.skip("no fact column to compare against")
    ref = f"{facts[0]['table']}.{facts[0]['name']}"
    for op in ("gt", "gte", "lt", "lte"):
        rows = run(conn, view, detail, a_metric, [f(field=ref, op=op, value=0)])
        print(op, "->", rows)
        assert rows is not None


def test_blank_tests_run(conn, view, detail, a_metric, text_field):
    for op in ("isBlank", "isNotBlank"):
        rows = run(conn, view, detail, a_metric, [f(field=text_field, op=op)])
        print(op, "->", rows)
        assert rows is not None


def test_not_between_runs(conn, view, detail, a_metric):
    facts = detail.get("facts") or []
    if not facts:
        pytest.skip("no fact column for a range")
    ref = f"{facts[0]['table']}.{facts[0]['name']}"
    rows = run(
        conn,
        view,
        detail,
        a_metric,
        [f(field=ref, op="notBetween", **{"from": 0, "to": 0})],
    )
    print("notBetween ->", rows)
    assert rows is not None


def test_mixed_operators_bind_in_order(conn, view, detail, a_metric, text_field):
    """isBlank binds nothing; the values after it must not shift a slot."""
    rows = run(
        conn,
        view,
        detail,
        a_metric,
        [
            f(id="a", field=text_field, op="contains", value="a"),
            f(id="b", field=text_field, op="isNotBlank"),
            f(id="c", field=text_field, op="startsWith", value="A"),
        ],
    )
    print("mixed ->", rows)
    assert rows is not None
