import pytest

from app.auth.sessions import SESSION_COOKIE, create_session
from app.reports.schema import MAX_DEFINITION_BYTES
from app.snowflake.provider import get_cache
from tests.fakes import FakeConnection
from tests.test_report_routes import oversized_definition, valid_definition

DESCRIBE = {
    "tables": [{"name": "A"}, {"name": "C"}],
    "relationships": [],
    "dimensions": [{"table": "C", "name": "REGION", "dataType": "TEXT"}],
    "metrics": [{"table": "A", "name": "REV", "dataType": "NUMBER(38,2)"}],
    "facts": [],
}


@pytest.fixture
def signed_in(client, db, monkeypatch):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    get_cache().put(sess.id, FakeConnection(), rebuildable=False)
    client.cookies.set(SESSION_COOKIE, sess.id)
    monkeypatch.setattr(
        "app.snowflake.provider.describe_semantic_view",
        lambda conn, d, s, n: DESCRIBE,
    )
    return sess


def test_import_creates_a_new_report(client, signed_in):
    response = client.post(
        "/api/reports/import", json={"definition": valid_definition()}
    )
    assert response.status_code == 201
    assert response.json()["name"] == "Sales overview"
    assert response.json()["definition"]["visuals"][0]["id"] == "v1"


def test_import_rejects_a_field_the_user_cannot_see(client, signed_in):
    doc = valid_definition()
    doc["visuals"][0]["wells"]["values"] = ["A.SECRET_MARGIN"]
    response = client.post("/api/reports/import", json={"definition": doc})
    assert response.status_code == 400
    assert response.json()["code"] == "REPORT_INVALID"
    assert "A.SECRET_MARGIN" in response.json()["message"]


def test_import_applies_a_view_override(client, signed_in):
    response = client.post(
        "/api/reports/import",
        json={
            "definition": valid_definition(),
            "viewOverride": {"database": "PROD", "schema": "MARTS", "name": "SALES_V2"},
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["view"] == {"database": "PROD", "schema": "MARTS", "name": "SALES_V2"}
    assert body["definition"]["view"]["database"] == "PROD"


def test_import_rejects_an_oversized_body(client, signed_in):
    # Built from many individually-legal visuals and refs -- every visual
    # count, refs-per-well count, ref length and title obeys its own field
    # limit, so only the shared MAX_DEFINITION_BYTES cap can reject this.
    # (The old version of this test built its payload from a single
    # 70000-char title, which `Visual.title`'s own max_length=200 already
    # rejects -- that test would have passed with or without a byte cap.)
    response = client.post(
        "/api/reports/import", json={"definition": oversized_definition()}
    )
    assert response.status_code == 400
    assert response.json()["code"] == "REPORT_INVALID"
    assert response.json()["message"] == (
        f"The definition exceeds the {MAX_DEFINITION_BYTES} byte limit"
    )


def test_import_always_creates_rather_than_overwrites(client, signed_in):
    first = client.post("/api/reports/import", json={"definition": valid_definition()})
    second = client.post("/api/reports/import", json={"definition": valid_definition()})
    assert first.json()["id"] != second.json()["id"]
    assert len(client.get("/api/reports").json()["reports"]) == 2


def test_import_requires_authentication(client):
    assert client.post(
        "/api/reports/import", json={"definition": valid_definition()}
    ).status_code == 401


def test_import_rejects_an_unbound_definition_with_no_view_override(client, signed_in):
    # There is nothing to DESCRIBE and validate field references against, so
    # an unbound import (no view, no override) is meaningless -- reject it
    # rather than silently creating a report nobody can use.
    doc = valid_definition()
    doc["view"] = {"database": "", "schema": "", "name": ""}
    doc["visuals"] = []
    response = client.post("/api/reports/import", json={"definition": doc})
    assert response.status_code == 400
    assert response.json()["code"] == "REPORT_INVALID"
    assert "view override" in response.json()["message"].lower()


def test_import_accepts_an_unbound_definition_when_a_view_override_is_supplied(
    client, signed_in
):
    doc = valid_definition()
    doc["view"] = {"database": "", "schema": "", "name": ""}
    doc["visuals"] = []
    response = client.post(
        "/api/reports/import",
        json={
            "definition": doc,
            "viewOverride": {"database": "PROD", "schema": "MARTS", "name": "SALES_V2"},
        },
    )
    assert response.status_code == 201
    assert response.json()["view"] == {
        "database": "PROD",
        "schema": "MARTS",
        "name": "SALES_V2",
    }
