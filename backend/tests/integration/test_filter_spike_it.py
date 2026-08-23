"""Spike: can SEMANTIC_VIEW() be filtered, and can the values be bound?

Not a regression suite -- this exists to answer four questions against a real
account before the filter feature is built on top of the answers. Run with:

    pytest tests/integration/test_filter_spike_it.py -v -s -m integration

The -s matters: the printed output is the deliverable.

Findings are written up in
docs/superpowers/specs/2026-08-15-filter-spike-findings.md.
"""

import os

import pytest
import snowflake.connector

from app.semantic.discovery import describe_semantic_view, list_semantic_views, quote_ident
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
    # paramstyle="qmark" explicitly, NOT connect_dev: the connector defaults to
    # pyformat, under which a "?" is not a placeholder at all and the binding
    # call dies in Python before Snowflake ever sees the statement. Q3/Q4 use
    # "?", so a pyformat connection would report a client-side TypeError as if
    # it were Snowflake rejecting the syntax.
    connection = snowflake.connector.connect(
        account=sf_connect.normalize_account(os.environ["SEMANTICUI_IT_ACCOUNT"]),
        user=os.environ["SEMANTICUI_IT_USER"],
        password=os.environ["SEMANTICUI_IT_PASSWORD"],
        paramstyle="qmark",
    )
    yield connection
    connection.close()


@pytest.fixture(scope="module")
def model(conn):
    db = os.environ.get("SEMANTICUI_IT_DATABASE")
    schema = os.environ.get("SEMANTICUI_IT_SCHEMA")
    name = os.environ.get("SEMANTICUI_IT_VIEW")
    if not (db and schema and name):
        views = list_semantic_views(conn)
        assert views, "account has no semantic views visible to this user"
        db, schema, name = views[0]["database"], views[0]["schema"], views[0]["name"]
    print(f"\n[model] {db}.{schema}.{name}")
    detail = describe_semantic_view(conn, db, schema, name)
    text_dims = [
        d
        for d in detail["dimensions"]
        if (d.get("dataType") or "").upper().startswith(("VARCHAR", "TEXT", "STRING", "CHAR"))
    ]
    # Fall back to any dimension at all: a model with only dates/numbers can
    # still answer every question here.
    dims = text_dims or detail["dimensions"]
    assert dims, "spike needs at least one dimension"
    assert detail["metrics"], "spike needs at least one metric"
    print(f"[model] dimension={dims[0]['table']}.{dims[0]['name']} "
          f"metric={detail['metrics'][0]['table']}.{detail['metrics'][0]['name']}")
    return {
        "ref": f"{quote_ident(db)}.{quote_ident(schema)}.{quote_ident(name)}",
        "dim": dims[0],
        "metric": detail["metrics"][0],
    }


def _fq(field: dict) -> str:
    return f"{quote_ident(field['table'])}.{quote_ident(field['name'])}"


def _sample_value(conn, model) -> str:
    """One real value of the chosen dimension, to filter on."""
    sql = (
        f"SELECT * FROM SEMANTIC_VIEW(\n  {model['ref']}\n"
        f"  DIMENSIONS {_fq(model['dim'])}\n) LIMIT 1"
    )
    cur = conn.cursor()
    try:
        cur.execute(sql)
        row = cur.fetchone()
        assert row is not None and row[0] is not None, "dimension has no non-null values"
        return str(row[0])
    finally:
        cur.close()


def test_q1_where_clause_is_accepted(conn, model):
    """Q1: does SEMANTIC_VIEW(...) take a WHERE clause, and where does it go?"""
    value = _sample_value(conn, model)
    literal = value.replace("'", "''")
    inside = (
        f"SELECT * FROM SEMANTIC_VIEW(\n  {model['ref']}\n"
        f"  DIMENSIONS {_fq(model['dim'])}\n"
        f"  METRICS {_fq(model['metric'])}\n"
        f"  WHERE {_fq(model['dim'])} = '{literal}'\n) LIMIT 10"
    )
    cur = conn.cursor()
    try:
        try:
            cur.execute(inside)
            rows = cur.fetchall()
            print(f"\n[Q1] WHERE *inside* SEMANTIC_VIEW: ACCEPTED, {len(rows)} row(s)")
            print(f"[Q1] SQL:\n{inside}")
            return
        except snowflake.connector.errors.Error as exc:
            print(f"\n[Q1] WHERE inside SEMANTIC_VIEW REJECTED: {exc.errno} {exc.msg}")
        outside = (
            f"SELECT * FROM SEMANTIC_VIEW(\n  {model['ref']}\n"
            f"  DIMENSIONS {_fq(model['dim'])}\n"
            f"  METRICS {_fq(model['metric'])}\n"
            f") WHERE {quote_ident(model['dim']['name'])} = '{literal}' LIMIT 10"
        )
        cur.execute(outside)
        rows = cur.fetchall()
        print(f"[Q1] WHERE *outside* the call: ACCEPTED, {len(rows)} row(s)")
        print(f"[Q1] SQL:\n{outside}")
        pytest.fail(
            "ASSUMPTION BROKEN: WHERE is only accepted outside SEMANTIC_VIEW(). "
            "Filtering cannot precede aggregation this way -- see the spec's "
            "ranked fallbacks and get sign-off before continuing."
        )
    finally:
        cur.close()


@pytest.mark.parametrize("paramstyle,placeholder", [("qmark", "?"), ("pyformat", "%s")])
def test_q2_bind_parameters_inside_the_filter(model, paramstyle, placeholder):
    """Q2: do bind parameters work inside that clause, and in which paramstyle?

    A fresh connection per paramstyle: the connector decides client- versus
    server-side binding from this value at connect time.
    """
    connection = snowflake.connector.connect(
        account=sf_connect.normalize_account(os.environ["SEMANTICUI_IT_ACCOUNT"]),
        user=os.environ["SEMANTICUI_IT_USER"],
        password=os.environ["SEMANTICUI_IT_PASSWORD"],
        paramstyle=paramstyle,
    )
    try:
        value = _sample_value(connection, model)
        sql = (
            f"SELECT * FROM SEMANTIC_VIEW(\n  {model['ref']}\n"
            f"  DIMENSIONS {_fq(model['dim'])}\n"
            f"  METRICS {_fq(model['metric'])}\n"
            f"  WHERE {_fq(model['dim'])} IN ({placeholder})\n) LIMIT 10"
        )
        cur = connection.cursor()
        try:
            cur.execute(sql, (value,))
            rows = cur.fetchall()
            print(f"\n[Q2] paramstyle={paramstyle!r} ({placeholder}): ACCEPTED, {len(rows)} row(s)")
        except snowflake.connector.errors.Error as exc:
            print(f"\n[Q2] paramstyle={paramstyle!r} ({placeholder}): REJECTED {exc.errno} {exc.msg}")
            pytest.fail(f"paramstyle {paramstyle} does not bind inside SEMANTIC_VIEW()")
        finally:
            cur.close()
    finally:
        connection.close()


def test_q3_filter_on_a_dimension_not_in_dimensions(conn, model):
    """Q3: the KPI case -- filter on a dimension the query does not select.

    This is the question that decides the feature's shape. A KPI card selects
    only a metric; if the filtered dimension must also appear in DIMENSIONS,
    every filtered KPI card silently becomes a grouped result.
    """
    value = _sample_value(conn, model)
    sql = (
        f"SELECT * FROM SEMANTIC_VIEW(\n  {model['ref']}\n"
        f"  METRICS {_fq(model['metric'])}\n"
        f"  WHERE {_fq(model['dim'])} = ?\n) LIMIT 10"
    )
    cur = conn.cursor()
    try:
        cur.execute(sql, (value,))
        rows = cur.fetchall()
        print(f"\n[Q3] filter on an unselected dimension: ACCEPTED, {len(rows)} row(s)")
        print(f"[Q3] rows: {rows[:3]}")
        assert len(rows) == 1, (
            f"expected a single aggregate row, got {len(rows)} -- the filtered "
            "dimension appears to have been added to the grouping"
        )
    except snowflake.connector.errors.Error as exc:
        print(f"\n[Q3] filter on an unselected dimension: REJECTED {exc.errno} {exc.msg}")
        pytest.fail(
            "ASSUMPTION BROKEN: a filtered dimension must also be selected. "
            "KPI cards cannot be filtered without becoming grouped results -- "
            "stop and get sign-off on the spec's fallback."
        )
    finally:
        cur.close()


def test_q4_clause_order_relative_to_order_by_and_limit(conn, model):
    """Q4: does WHERE coexist with ORDER BY and LIMIT, and in what order?"""
    value = _sample_value(conn, model)
    sql = (
        f"SELECT * FROM SEMANTIC_VIEW(\n  {model['ref']}\n"
        f"  DIMENSIONS {_fq(model['dim'])}\n"
        f"  METRICS {_fq(model['metric'])}\n"
        f"  WHERE {_fq(model['dim'])} <> ?\n"
        f") ORDER BY {quote_ident(model['metric']['name'])} DESC LIMIT 5"
    )
    cur = conn.cursor()
    try:
        cur.execute(sql, (value,))
        rows = cur.fetchall()
        print(f"\n[Q4] WHERE + ORDER BY + LIMIT together: ACCEPTED, {len(rows)} row(s)")
        print(f"[Q4] SQL:\n{sql}")
    finally:
        cur.close()
