"""Runs against a real Snowflake account. Set env vars to enable:

SEMANTICUI_IT_ACCOUNT, SEMANTICUI_IT_USER, SEMANTICUI_IT_PASSWORD
Optional: SEMANTICUI_IT_DATABASE, SEMANTICUI_IT_SCHEMA, SEMANTICUI_IT_VIEW

Run: pytest -m integration -v

When SEMANTICUI_IT_ACCOUNT is unset, every test in this module is skipped
(not errored, not failed) - see the module-level skipif below, mirroring
test_snowflake_it.py exactly.

This is the test that would catch a DESCRIBE-shape change breaking import:
it signs in with the connector directly (no HTTP layer, no fakes), builds a
report definition from the real view's own first dimension and metric, runs
it through the actual `import_report` service call - which re-validates
every field reference against a live DESCRIBE - and asserts the stored
definition round-trips byte-for-byte through `to_export_document`.
"""
import os
import time

import pytest

from app.auth.sessions import create_session
from app.reports import service
from app.reports.schema import parse_definition, to_export_document
from app.semantic.discovery import describe_semantic_view, list_semantic_views
from app.snowflake import connect as sf_connect
from app.snowflake.provider import CacheEntry, ConnectionCache

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


def test_report_round_trip_against_a_real_view(conn, view_ref, db):
    """Build a definition from real DESCRIBE output, import it, and confirm
    the report the service stored exports back out unchanged."""
    database, schema, name = view_ref
    detail = describe_semantic_view(conn, database, schema, name)
    assert detail["dimensions"], "view has no dimension to build a report from"
    assert detail["metrics"], "view has no metric to build a report from"

    dim = detail["dimensions"][0]
    met = detail["metrics"][0]
    dim_ref = f"{dim['table']}.{dim['name']}"
    met_ref = f"{met['table']}.{met['name']}"

    raw_definition = {
        "schemaVersion": 1,
        "name": "IT round trip",
        "view": {"database": database, "schema": schema, "name": name},
        "canvas": {"columns": 12, "rowHeight": 40},
        "visuals": [
            {
                "id": "v1",
                "type": "bar",
                "title": "",
                "layout": {"x": 0, "y": 0, "w": 6, "h": 6},
                "wells": {"axis": [dim_ref], "legend": [], "values": [met_ref]},
                "options": {},
            }
        ],
    }

    sess = create_session(
        db,
        account=os.environ["SEMANTICUI_IT_ACCOUNT"],
        user=os.environ["SEMANTICUI_IT_USER"],
        mode="dev",
    )
    # A bare CacheEntry/ConnectionCache pair, not the app-wide singleton from
    # `app.snowflake.provider.get_cache()` - the service only ever calls
    # `cache.describe(entry, ...)`, which just runs a real DESCRIBE against
    # `entry.conn` and memoizes it on the entry. No HTTP layer, no session
    # middleware needed to exercise that path directly.
    cache = ConnectionCache(idle_ttl=3600, max_size=10)
    entry = CacheEntry(conn=conn, last_used=time.monotonic())

    report = service.import_report(db, sess.user_id, entry, cache, raw_definition)

    expected = to_export_document(parse_definition(raw_definition))
    actual = to_export_document(parse_definition(report.definition))
    assert actual == expected
