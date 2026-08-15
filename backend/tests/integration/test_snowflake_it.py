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

from app.semantic.discovery import describe_semantic_view, list_semantic_views
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
    sql, limit = build_semantic_sql(detail, req, max_rows=10000)
    result = run_query(conn, sql, max_rows=limit)
    assert result.columns
    assert len(result.rows) <= 5
