import json

from sqlalchemy import select

from app.auth.sessions import SESSION_COOKIE, create_session
from app.db.models import Report, User
from app.reports.schema import MAX_DEFINITION_BYTES, MAX_REFS_PER_WELL, MAX_VISUALS


def valid_definition(name="Sales overview"):
    return {
        "schemaVersion": 1,
        "name": name,
        "view": {"database": "ANALYTICS", "schema": "PUBLIC", "name": "SALES"},
        "canvas": {"columns": 12, "rowHeight": 40},
        "visuals": [
            {
                "id": "v1",
                "type": "bar",
                "title": "Revenue by region",
                "layout": {"x": 0, "y": 0, "w": 6, "h": 6},
                "wells": {"axis": ["C.REGION"], "legend": [], "values": ["A.REV"]},
                "options": {"stacked": False},
            }
        ],
    }


def oversized_definition():
    """A definition that is large only because it holds many legal visuals and
    refs. Every individual value stays inside the schema's own per-field
    limits (visual count <= MAX_VISUALS, refs-per-well <= MAX_REFS_PER_WELL,
    each ref comfortably under the 511-char TABLE.FIELD cap, title <= 200
    chars), so the *only* thing that can reject this document is the shared
    MAX_DEFINITION_BYTES cap -- unlike the old version of this fixture, which
    relied on `Visual.title`'s own max_length and so would have passed with
    or without a byte cap.
    """
    pad = "X" * 100
    visuals = []
    for i in range(MAX_VISUALS):
        dims = [f"D{i}.FIELD_{k:03d}_{pad}" for k in range(MAX_REFS_PER_WELL)]
        mets = [f"M{i}.FIELD_{k:03d}_{pad}" for k in range(MAX_REFS_PER_WELL)]
        visuals.append(
            {
                "id": f"v{i}",
                "type": "table",
                "title": "Visual",
                "layout": {"x": 0, "y": i, "w": 6, "h": 1},
                "wells": {"dimensions": dims, "metrics": mets},
                "options": {},
            }
        )
    return {
        "schemaVersion": 1,
        "name": "Huge report",
        "view": {"database": "ANALYTICS", "schema": "PUBLIC", "name": "SALES"},
        "canvas": {"columns": 12, "rowHeight": 40},
        "visuals": visuals,
    }


def sign_in(client, db, user="ALICE"):
    sess = create_session(db, account="ACME", user=user, mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    return sess


def test_reports_require_authentication(client):
    assert client.get("/api/reports").status_code == 401
    assert client.post("/api/reports", json={"definition": valid_definition()}).status_code == 401


def test_create_list_get_update_delete(client, db):
    sign_in(client, db)

    created = client.post("/api/reports", json={"definition": valid_definition()})
    assert created.status_code == 201
    report_id = created.json()["id"]
    assert created.json()["name"] == "Sales overview"
    assert created.json()["view"]["name"] == "SALES"

    listing = client.get("/api/reports")
    assert listing.status_code == 200
    assert [r["id"] for r in listing.json()["reports"]] == [report_id]
    assert "definition" not in listing.json()["reports"][0]

    detail = client.get(f"/api/reports/{report_id}")
    assert detail.status_code == 200
    assert detail.json()["definition"]["visuals"][0]["id"] == "v1"

    renamed = valid_definition(name="Renamed")
    updated = client.put(f"/api/reports/{report_id}", json={"definition": renamed})
    assert updated.status_code == 200
    assert updated.json()["name"] == "Renamed"
    assert client.get(f"/api/reports/{report_id}").json()["name"] == "Renamed"

    assert client.delete(f"/api/reports/{report_id}").status_code == 204
    assert client.get(f"/api/reports/{report_id}").status_code == 404


def test_another_users_report_is_404_not_403(client, db):
    """Non-owners must not be able to distinguish 'exists' from 'not yours'."""
    sign_in(client, db, user="ALICE")
    report_id = client.post("/api/reports", json={"definition": valid_definition()}).json()["id"]

    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    client.cookies.set(SESSION_COOKIE, bob.id)
    assert client.get("/api/reports").json()["reports"] == []
    assert client.get(f"/api/reports/{report_id}").status_code == 404
    assert client.put(f"/api/reports/{report_id}", json={"definition": valid_definition()}).status_code == 404
    assert client.delete(f"/api/reports/{report_id}").status_code == 404


def test_invalid_definition_is_rejected(client, db):
    sign_in(client, db)
    bad = valid_definition()
    bad["visuals"][0]["type"] = "hologram"
    response = client.post("/api/reports", json={"definition": bad})
    assert response.status_code == 400
    assert response.json()["code"] == "REPORT_INVALID"


def test_create_rejects_an_oversized_definition(client, db):
    sign_in(client, db)
    response = client.post("/api/reports", json={"definition": oversized_definition()})
    assert response.status_code == 400
    assert response.json()["code"] == "REPORT_INVALID"
    assert f"exceeds the {MAX_DEFINITION_BYTES} byte limit" in response.json()["message"]
    # Nothing was persisted -- the request was rejected, not silently
    # truncated or stored oversized.
    assert client.get("/api/reports").json()["reports"] == []


def test_update_rejects_an_oversized_definition(client, db):
    sign_in(client, db)
    report_id = client.post("/api/reports", json={"definition": valid_definition()}).json()["id"]

    response = client.put(
        f"/api/reports/{report_id}", json={"definition": oversized_definition()}
    )
    assert response.status_code == 400
    assert response.json()["code"] == "REPORT_INVALID"
    assert f"exceeds the {MAX_DEFINITION_BYTES} byte limit" in response.json()["message"]
    # The existing report is untouched by the rejected update.
    assert client.get(f"/api/reports/{report_id}").json()["name"] == "Sales overview"


def test_export_is_deterministic_and_carries_no_identity(client, db):
    sign_in(client, db)
    report_id = client.post("/api/reports", json={"definition": valid_definition()}).json()["id"]
    first = client.get(f"/api/reports/{report_id}/export")
    second = client.get(f"/api/reports/{report_id}/export")
    assert first.status_code == 200
    assert first.text == second.text
    assert report_id not in first.text
    for leaked in ("ALICE", "ACME", "owner", "createdAt", "updatedAt"):
        assert leaked not in first.text
    assert json.loads(first.text)["view"]["name"] == "SALES"


def test_report_row_stores_no_query_results(client, db):
    sign_in(client, db)
    client.post("/api/reports", json={"definition": valid_definition()})
    row = db.scalars(select(Report)).one()
    # An exact set, not a subset: the point is that the row holds the
    # definition and NOTHING else -- no cached rows, no query results.
    assert set(row.definition) == {
        "schemaVersion", "name", "view", "canvas", "visuals", "filters", "hierarchies",
    }
