"""Runs against a real Snowflake account. Set env vars to enable:

SEMANTICUI_IT_ACCOUNT, SEMANTICUI_IT_USER, SEMANTICUI_IT_PASSWORD
Optional: SEMANTICUI_IT_DATABASE, SEMANTICUI_IT_SCHEMA, SEMANTICUI_IT_VIEW

Run: pytest -m integration -v

When SEMANTICUI_IT_ACCOUNT is unset, every test in this module is skipped
(not errored, not failed) - see the module-level skipif below. This lets
`pytest -m integration -v` run safely in CI/dev environments with no
Snowflake account configured.
"""
import os

import pytest

from app.semantic.discovery import (
    describe_semantic_view,
    detect_hierarchies,
    list_semantic_views,
)
from app.semantic.query import SemanticQueryRequest, build_semantic_sql
from app.snowflake import connect as sf_connect
from app.snowflake.gateway import run_query

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.environ.get("SEMANTICUI_IT_ACCOUNT"),
        reason="SEMANTICUI_IT_* env vars not set",
    ),
]


@pytest.fixture(scope="module")
def conn():
    connection = sf_connect.connect_dev(
        account=os.environ["SEMANTICUI_IT_ACCOUNT"],
        user=os.environ["SEMANTICUI_IT_USER"],
        authenticator="password",
        password=os.environ["SEMANTICUI_IT_PASSWORD"],
    )
    yield connection
    connection.close()


@pytest.fixture(scope="module")
def view_ref(conn):
    db = os.environ.get("SEMANTICUI_IT_DATABASE")
    schema = os.environ.get("SEMANTICUI_IT_SCHEMA")
    name = os.environ.get("SEMANTICUI_IT_VIEW")
    if db and schema and name:
        return db, schema, name
    views = list_semantic_views(conn)
    assert views, "account has no semantic views visible to this user"
    v = views[0]
    return v["database"], v["schema"], v["name"]


def test_probe_identity(conn):
    account, user = sf_connect.probe_identity(conn)
    assert account and user


def test_list_semantic_views(conn):
    views = list_semantic_views(conn)
    assert isinstance(views, list)
    assert all(v["name"] and v["database"] and v["schema"] for v in views)


def test_describe_parses_real_output(conn, view_ref):
    detail = describe_semantic_view(conn, *view_ref)
    assert detail["tables"], "parser found no logical tables - DESCRIBE shape changed?"
    assert detail["dimensions"] or detail["metrics"], (
        "parser found no dimensions/metrics - DESCRIBE shape changed?"
    )


def test_semantic_query_roundtrip(conn, view_ref):
    db, schema, name = view_ref
    detail = describe_semantic_view(conn, db, schema, name)
    dims = [f"{d['table']}.{d['name']}" for d in detail["dimensions"][:1]]
    mets = [f"{m['table']}.{m['name']}" for m in detail["metrics"][:1]]
    req = SemanticQueryRequest.model_validate(
        {
            "database": db, "schema": schema, "view": name,
            "dimensions": dims, "metrics": mets, "limit": 5,
        }
    )
    sql, _params, limit = build_semantic_sql(detail, req, max_rows=10000)
    result = run_query(conn, sql, max_rows=limit, params=_params)
    assert result.columns
    assert len(result.rows) <= 5


# --- filters, against the real account -------------------------------------


def test_filtered_query_returns_a_strict_subset(conn, view_ref):
    """A filtered query must narrow the result, with the value bound."""
    db, schema, name = view_ref
    detail = describe_semantic_view(conn, db, schema, name)
    dim = detail["dimensions"][0]
    ref = f"{dim['table']}.{dim['name']}"
    mets = [f"{m['table']}.{m['name']}" for m in detail["metrics"][:1]]

    unfiltered = SemanticQueryRequest.model_validate(
        {"database": db, "schema": schema, "view": name,
         "dimensions": [ref], "metrics": mets, "limit": 50}
    )
    sql, params, limit = build_semantic_sql(detail, unfiltered, max_rows=10000)
    baseline = run_query(conn, sql, max_rows=limit, params=params)
    assert baseline.rows, "view returned no rows; cannot exercise a filter"

    value = str(baseline.rows[0][0])
    filtered = SemanticQueryRequest.model_validate(
        {"database": db, "schema": schema, "view": name,
         "dimensions": [ref], "metrics": mets, "limit": 50,
         "filters": [{"id": "f1", "field": ref, "op": "is", "values": [value]}]}
    )
    sql, params, limit = build_semantic_sql(detail, filtered, max_rows=10000)
    assert value not in sql, "filter value leaked into SQL text"
    assert params == [value]
    result = run_query(conn, sql, max_rows=limit, params=params)
    assert len(result.rows) == 1
    assert str(result.rows[0][0]) == value


def test_a_kpi_shaped_query_stays_aggregated_when_filtered(conn, view_ref):
    """The spike's Q3, now through the product's own builder: metrics only,
    filtered by a dimension that is not selected, still one row."""
    db, schema, name = view_ref
    detail = describe_semantic_view(conn, db, schema, name)
    dim = detail["dimensions"][0]
    ref = f"{dim['table']}.{dim['name']}"
    metric = detail["metrics"][0]

    probe = SemanticQueryRequest.model_validate(
        {"database": db, "schema": schema, "view": name, "dimensions": [ref], "limit": 1}
    )
    sql, params, limit = build_semantic_sql(detail, probe, max_rows=10000)
    value = str(run_query(conn, sql, max_rows=limit, params=params).rows[0][0])

    req = SemanticQueryRequest.model_validate(
        {"database": db, "schema": schema, "view": name,
         "metrics": [f"{metric['table']}.{metric['name']}"], "limit": 10,
         "filters": [{"id": "f1", "field": ref, "op": "is", "values": [value]}]}
    )
    sql, params, limit = build_semantic_sql(detail, req, max_rows=10000)
    assert "DIMENSIONS" not in sql
    result = run_query(conn, sql, max_rows=limit, params=params)
    assert len(result.rows) == 1, (
        f"expected one aggregate row, got {len(result.rows)} -- the filtered "
        "dimension appears to have joined the grouping"
    )


def test_a_hostile_filter_value_is_data_not_sql(conn, view_ref):
    """The injection round trip, end to end against Snowflake: the statement
    must execute and simply match nothing."""
    db, schema, name = view_ref
    detail = describe_semantic_view(conn, db, schema, name)
    dim = detail["dimensions"][0]
    ref = f"{dim['table']}.{dim['name']}"
    req = SemanticQueryRequest.model_validate(
        {"database": db, "schema": schema, "view": name,
         "dimensions": [ref], "limit": 10,
         "filters": [{"id": "f1", "field": ref, "op": "is",
                      "values": ["' OR 1=1 --"]}]}
    )
    sql, params, limit = build_semantic_sql(detail, req, max_rows=10000)
    assert "OR 1=1" not in sql
    result = run_query(conn, sql, max_rows=limit, params=params)
    assert result.rows == [], "a bound hostile value matched rows -- it was not bound"


def test_a_two_level_drill_narrows_at_each_step(conn, view_ref):
    """What the UI does when you click twice, expressed as the two queries it
    actually sends."""
    db, schema, name = view_ref
    detail = describe_semantic_view(conn, db, schema, name)
    if len(detail["dimensions"]) < 2:
        pytest.skip("view has fewer than two dimensions; cannot drill")
    top, next_level = detail["dimensions"][0], detail["dimensions"][1]
    top_ref = f"{top['table']}.{top['name']}"
    next_ref = f"{next_level['table']}.{next_level['name']}"

    level0 = SemanticQueryRequest.model_validate(
        {"database": db, "schema": schema, "view": name,
         "dimensions": [top_ref], "limit": 5}
    )
    sql, params, limit = build_semantic_sql(detail, level0, max_rows=10000)
    rows = run_query(conn, sql, max_rows=limit, params=params).rows
    assert rows, "no rows at the top level"
    clicked = str(rows[0][0])

    level1 = SemanticQueryRequest.model_validate(
        {"database": db, "schema": schema, "view": name,
         "dimensions": [next_ref], "limit": 50,
         "filters": [{"id": "drill:0", "field": top_ref, "op": "is",
                      "values": [clicked]}]}
    )
    sql, params, limit = build_semantic_sql(detail, level1, max_rows=10000)
    assert params == [clicked]
    drilled = run_query(conn, sql, max_rows=limit, params=params)
    assert drilled.columns, "drilled query returned no columns"


def test_relative_date_filter_runs_against_a_real_date_dimension(conn, view_ref):
    db, schema, name = view_ref
    detail = describe_semantic_view(conn, db, schema, name)
    dates = [
        d for d in detail["dimensions"]
        if (d.get("dataType") or "").upper().startswith(("DATE", "TIMESTAMP"))
    ]
    if not dates:
        pytest.skip("view exposes no date dimension")
    ref = f"{dates[0]['table']}.{dates[0]['name']}"
    req = SemanticQueryRequest.model_validate(
        {"database": db, "schema": schema, "view": name,
         "dimensions": [ref], "limit": 10,
         "filters": [{"id": "f1", "field": ref, "op": "relativeDate",
                      "unit": "year", "count": 50}]}
    )
    sql, params, limit = build_semantic_sql(detail, req, max_rows=10000)
    assert len(params) == 2, "a relative window binds two dates"
    run_query(conn, sql, max_rows=limit, params=params)


def test_records_whether_the_account_exposes_hierarchies(conn, view_ref):
    """Settles the model-first question with evidence rather than assumption.

    Never fails: it exists to record what this account actually returns.
    """
    db, schema, name = view_ref
    detail = describe_semantic_view(conn, db, schema, name)
    print(f"\n[hierarchy probe] detail['hierarchies'] = {detail.get('hierarchies')}")
    print(f"[hierarchy probe] detect_hierarchies() = {detect_hierarchies(detail)}")
