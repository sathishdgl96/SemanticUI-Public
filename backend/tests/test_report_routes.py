import json

from sqlalchemy import select

from app.auth.sessions import SESSION_COOKIE, create_session
from app.db.models import Report, User, Workspace, WorkspaceMember
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
    # `valid_definition` is deliberately still a v1 document: every route test
    # therefore exercises the whole migration chain end to end, and what comes
    # back is the current shape.
    assert detail.json()["definition"]["schemaVersion"] == 3
    assert detail.json()["definition"]["pages"][0]["visuals"][0]["id"] == "v1"

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
        "schemaVersion", "name", "view", "canvas", "pages", "filters", "hierarchies",
    }
    # Visuals live inside pages now, and still carry nothing but their own
    # definition -- no rows, no results.
    assert set(row.definition["pages"][0]) == {"id", "name", "visuals", "filters"}


def test_get_serves_a_row_stored_before_the_pages_bump_as_v3(client, db):
    """Rows written by an older build must not reach the frontend in a shape
    it no longer reads -- migrating only on save would strand them."""
    sign_in(client, db)
    report_id = client.post(
        "/api/reports", json={"definition": valid_definition()}
    ).json()["id"]

    # Overwrite the stored JSON with a genuine v2 document, exactly as a
    # pre-bump build would have written it.
    row = db.scalars(select(Report)).one()
    row.definition = {
        "schemaVersion": 2,
        "name": "Older report",
        "view": {"database": "ANALYTICS", "schema": "PUBLIC", "name": "SALES"},
        "canvas": {"columns": 12, "rowHeight": 40},
        "visuals": [],
        "filters": [
            {"id": "f1", "field": "C.REGION", "op": "is", "values": ["EAST"]}
        ],
        "hierarchies": [],
    }
    db.commit()

    definition = client.get(f"/api/reports/{report_id}").json()["definition"]
    assert definition["schemaVersion"] == 3
    assert "visuals" not in definition
    assert definition["pages"][0]["name"] == "Page 1"
    assert definition["pages"][0]["filters"][0]["field"] == "C.REGION"


# --- workspace-scoped access ----------------------------------------------


def _shared_workspace(db, user_id, name="Team", role="editor"):
    ws = Workspace(name=name, kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=user_id, role=role))
    db.commit()
    return ws


def _report_in(db, workspace, owner_id, name="R"):
    report = Report(
        owner_user_id=owner_id,
        workspace_id=workspace.id,
        name=name,
        view_database="ANALYTICS",
        view_schema="PUBLIC",
        view_name="SALES",
        definition=valid_definition(name),
    )
    db.add(report)
    db.commit()
    return report


def test_a_report_in_someone_elses_workspace_is_404_on_every_verb(client, db):
    """404 and not 403: a stranger must not learn that this id exists."""
    sign_in(client, db)
    other = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    theirs_ws = _shared_workspace(db, other.user_id, "Theirs", role="admin")
    theirs = _report_in(db, theirs_ws, other.user_id, "Theirs")

    assert client.get(f"/api/reports/{theirs.id}").status_code == 404
    assert client.get(f"/api/reports/{theirs.id}/export").status_code == 404
    assert (
        client.put(
            f"/api/reports/{theirs.id}", json={"definition": valid_definition()}
        ).status_code
        == 404
    )
    assert client.delete(f"/api/reports/{theirs.id}").status_code == 404


def test_a_viewer_may_read_but_not_write(client, db):
    """The role split, end to end: same report, same workspace, two verbs."""
    sess = sign_in(client, db)
    ws = _shared_workspace(db, sess.user_id, role="viewer")
    report = _report_in(db, ws, sess.user_id)

    assert client.get(f"/api/reports/{report.id}").status_code == 200
    assert client.get(f"/api/reports/{report.id}/export").status_code == 200

    write = client.put(
        f"/api/reports/{report.id}", json={"definition": valid_definition()}
    )
    assert write.status_code == 403
    assert write.json()["code"] == "WORKSPACE_FORBIDDEN"
    assert "editor" in write.json()["message"]
    assert client.delete(f"/api/reports/{report.id}").status_code == 403


def test_an_editor_may_write(client, db):
    sess = sign_in(client, db)
    ws = _shared_workspace(db, sess.user_id, role="editor")
    report = _report_in(db, ws, sess.user_id)
    assert (
        client.put(
            f"/api/reports/{report.id}", json={"definition": valid_definition()}
        ).status_code
        == 200
    )


def test_listing_spans_every_workspace_i_belong_to(client, db):
    sess = sign_in(client, db)
    ws = _shared_workspace(db, sess.user_id, role="viewer")
    _report_in(db, ws, sess.user_id, "In the team ws")
    client.post("/api/reports", json={"definition": valid_definition()})

    names = [r["name"] for r in client.get("/api/reports").json()["reports"]]
    assert "In the team ws" in names
    assert "Sales overview" in names


def test_listing_can_be_scoped_to_one_workspace(client, db):
    sess = sign_in(client, db)
    ws = _shared_workspace(db, sess.user_id, role="viewer")
    _report_in(db, ws, sess.user_id, "In the team ws")
    client.post("/api/reports", json={"definition": valid_definition()})

    scoped = client.get("/api/reports", params={"workspace": str(ws.id)}).json()
    assert [r["name"] for r in scoped["reports"]] == ["In the team ws"]


def test_scoping_to_a_workspace_i_do_not_belong_to_is_404_not_an_empty_list(client, db):
    """An empty list would read as "no reports here", which is a different and
    misleading answer."""
    sign_in(client, db)
    other = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    theirs = _shared_workspace(db, other.user_id, "Theirs", role="admin")
    assert (
        client.get("/api/reports", params={"workspace": str(theirs.id)}).status_code
        == 404
    )


def test_a_new_report_lands_in_my_personal_workspace_by_default(client, db):
    sess = sign_in(client, db)
    created = client.post("/api/reports", json={"definition": valid_definition()}).json()
    personal = (
        db.query(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .filter(WorkspaceMember.user_id == sess.user_id, Workspace.kind == "personal")
        .one()
    )
    assert created["workspaceId"] == str(personal.id)
    assert created["workspaceName"] == "My reports"
    assert created["myRole"] == "admin"


def test_creating_in_a_workspace_i_can_only_read_is_403(client, db):
    sess = sign_in(client, db)
    ws = _shared_workspace(db, sess.user_id, role="viewer")
    response = client.post(
        "/api/reports",
        json={"definition": valid_definition(), "workspaceId": str(ws.id)},
    )
    assert response.status_code == 403


def test_creating_in_a_workspace_i_do_not_belong_to_is_404(client, db):
    sign_in(client, db)
    other = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    theirs = _shared_workspace(db, other.user_id, "Theirs", role="admin")
    response = client.post(
        "/api/reports",
        json={"definition": valid_definition(), "workspaceId": str(theirs.id)},
    )
    assert response.status_code == 404


def test_creating_in_a_workspace_i_can_write_to_lands_there(client, db):
    sess = sign_in(client, db)
    ws = _shared_workspace(db, sess.user_id, role="editor")
    created = client.post(
        "/api/reports",
        json={"definition": valid_definition(), "workspaceId": str(ws.id)},
    ).json()
    assert created["workspaceId"] == str(ws.id)
    assert created["workspaceName"] == "Team"
    assert created["myRole"] == "editor"
