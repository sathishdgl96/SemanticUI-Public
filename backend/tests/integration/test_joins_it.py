"""Is the join graph we reason about the one Snowflake enforces?

app/semantic/joins.py encodes rules that appear in no documentation -- they
were established by running combinations against a real account and reading
the errors. Rules discovered that way can go stale without warning, and the
failure mode is quiet: we would refuse queries Snowflake would now accept,
or repair ones that no longer need it.

So this suite asserts both directions. What we repair must run, and what we
refuse must still be refused BY SNOWFLAKE -- the raw SQL is built by hand
here, bypassing our own guard, precisely so the guard is not what is being
tested.

    pytest tests/integration/test_joins_it.py -v -s -m integration
"""

import os

import pytest
import snowflake.connector

from app.errors import ApiError
from app.semantic.discovery import describe_semantic_view
from app.semantic.joins import build_join_graph, reachable
from app.semantic.query import SemanticQueryRequest, bridged_through, build_semantic_sql
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


def request_for(view, **overrides):
    body = {
        "database": view[0], "schema": view[1], "view": view[2],
        "dimensions": [], "metrics": [], "limit": 5,
    }
    body.update(overrides)
    return SemanticQueryRequest.model_validate(body)


def run(conn, sql, params=None):
    cur = conn.cursor()
    try:
        cur.execute(sql, params) if params else cur.execute(sql)
        return [c[0] for c in cur.description], cur.fetchall()
    finally:
        cur.close()


def _siblings(detail):
    """Two dimensions whose entities cannot reach each other, or skip."""
    graph = build_join_graph(detail)
    dims = detail["dimensions"]
    for left in dims:
        for right in dims:
            a, b = (left["table"] or "").upper(), (right["table"] or "").upper()
            if a == b:
                continue
            if b not in reachable(graph, a) and a not in reachable(graph, b):
                return (
                    f"{left['table']}.{left['name']}",
                    f"{right['table']}.{right['name']}",
                )
    pytest.skip("this view has no two mutually unreachable dimension entities")


def _coarse_metric_and_finer_dimension(detail):
    graph = build_join_graph(detail)
    for metric in detail["metrics"]:
        base = (metric.get("table") or "").upper()
        for dim in detail["dimensions"]:
            if (dim["table"] or "").upper() not in reachable(graph, base):
                return (
                    f"{metric['table']}.{metric['name']}",
                    f"{dim['table']}.{dim['name']}",
                )
    pytest.skip("every metric in this view reaches every dimension")


def test_describe_exposes_relationship_endpoints(detail):
    # Everything else here rests on this. Names alone -- which is all the
    # parser used to keep -- would leave the graph edgeless.
    assert detail["relationships"], "view declares no relationships"
    for relationship in detail["relationships"]:
        assert relationship["table"] and relationship["refTable"], relationship


def test_snowflake_still_rejects_an_unbridged_sibling_pair(conn, detail, view):
    left, right = _siblings(detail)
    lt, ln = left.split(".")
    rt, rn = right.split(".")
    fqn = f'"{view[0]}"."{view[1]}"."{view[2]}"'
    # Hand-built on purpose: build_semantic_sql would repair this, and the
    # point is to confirm the thing being repaired is still broken.
    raw = (
        f'SELECT * FROM SEMANTIC_VIEW({fqn} DIMENSIONS "{lt}"."{ln}", "{rt}"."{rn}") LIMIT 5'
    )
    with pytest.raises(Exception) as excinfo:
        run(conn, raw)
    assert "Invalid dimension specified" in str(excinfo.value)


def test_the_bridge_makes_that_same_pair_run(conn, detail, view):
    left, right = _siblings(detail)
    req = request_for(view, dimensions=[left, right])
    sql, params, limit = build_semantic_sql(detail, req, max_rows=50)
    assert "EXCLUDE" in sql, sql
    columns, rows = run(conn, sql, params)
    # Exactly the two fields asked for: the bridging measure is joined
    # through, never returned.
    assert columns == [left.split(".")[1], right.split(".")[1]]
    assert rows, "bridged query returned nothing"
    assert bridged_through(detail, req)


def test_a_coarse_metric_is_refused_here_and_would_be_refused_there(conn, detail, view):
    metric, dimension = _coarse_metric_and_finer_dimension(detail)
    with pytest.raises(ApiError) as ours:
        build_semantic_sql(
            detail, request_for(view, dimensions=[dimension], metrics=[metric]), max_rows=50
        )
    assert metric in ours.value.message and dimension in ours.value.message

    mt, mn = metric.split(".")
    dt, dn = dimension.split(".")
    fqn = f'"{view[0]}"."{view[1]}"."{view[2]}"'
    raw = (
        f'SELECT * FROM SEMANTIC_VIEW({fqn} DIMENSIONS "{dt}"."{dn}"'
        f' METRICS "{mt}"."{mn}") LIMIT 5'
    )
    with pytest.raises(Exception) as theirs:
        run(conn, raw)
    assert "Invalid dimension specified" in str(theirs.value)


def test_a_reachable_combination_is_never_touched(conn, detail, view):
    graph = build_join_graph(detail)
    metric = next(
        (
            m
            for m in detail["metrics"]
            if {(d["table"] or "").upper() for d in detail["dimensions"]}
            <= reachable(graph, (m.get("table") or "").upper())
        ),
        None,
    )
    if metric is None:
        pytest.skip("no metric in this view reaches every dimension")
    dimensions = [f"{d['table']}.{d['name']}" for d in detail["dimensions"][:3]]
    req = request_for(view, dimensions=dimensions, metrics=[f"{metric['table']}.{metric['name']}"])
    sql, params, _ = build_semantic_sql(detail, req, max_rows=50)
    assert "EXCLUDE" not in sql
    assert bridged_through(detail, req) is None
    _columns, rows = run(conn, sql, params)
    assert rows
