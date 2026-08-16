import uuid

from app.auth.sessions import SESSION_COOKIE, create_session
from app.db.models import Report, Workspace, WorkspaceMember
from tests.test_report_routes import valid_definition


def sign_in(client, db, *, account="ACME", user="ALICE"):
    sess = create_session(db, account=account, user=user, mode="dev")
    db.commit()
    client.cookies.set(SESSION_COOKIE, sess.id)
    return sess


def test_endpoints_require_auth(client):
    assert client.get("/api/workspaces").status_code == 401
    assert client.post("/api/workspaces", json={"name": "X"}).status_code == 401


def test_listing_shows_my_personal_workspace_first(client, db):
    """Personal first because that is where people look first, and a switcher
    that reorders itself is disorienting."""
    sign_in(client, db)
    client.post("/api/workspaces", json={"name": "Team"})
    body = client.get("/api/workspaces").json()["workspaces"]
    assert body[0]["kind"] == "personal"
    assert body[0]["name"] == "My reports"
    assert [w["name"] for w in body][1:] == ["Team"]


def test_creating_a_workspace_makes_me_its_admin(client, db):
    sign_in(client, db)
    created = client.post("/api/workspaces", json={"name": "Team"})
    assert created.status_code == 201
    assert created.json()["myRole"] == "admin"
    assert created.json()["kind"] == "shared"


def test_a_new_workspace_inherits_my_snowflake_account(client, db):
    sign_in(client, db, account="XRIIEIM")
    created = client.post("/api/workspaces", json={"name": "Team"}).json()
    ws = db.get(Workspace, uuid.UUID(created["id"]))
    assert ws.snowflake_account == "XRIIEIM"


def test_listing_never_shows_a_workspace_i_do_not_belong_to(client, db):
    sign_in(client, db)
    other = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    stranger = Workspace(name="Secret", kind="shared", snowflake_account="ACME")
    db.add(stranger)
    db.flush()
    db.add(
        WorkspaceMember(workspace_id=stranger.id, user_id=other.user_id, role="admin")
    )
    db.commit()
    names = [w["name"] for w in client.get("/api/workspaces").json()["workspaces"]]
    assert "Secret" not in names


def test_listing_counts_members_and_reports(client, db):
    sign_in(client, db)
    created = client.post("/api/workspaces", json={"name": "Team"}).json()
    client.post(
        "/api/reports",
        json={"definition": valid_definition(), "workspaceId": created["id"]},
    )
    row = next(
        w
        for w in client.get("/api/workspaces").json()["workspaces"]
        if w["id"] == created["id"]
    )
    assert row["memberCount"] == 1
    assert row["reportCount"] == 1


def test_a_freshly_created_workspace_reports_real_counts(client, db):
    """Not zeroes: the client renders these straight into the switcher."""
    sign_in(client, db)
    created = client.post("/api/workspaces", json={"name": "Team"}).json()
    assert created["memberCount"] == 1
    assert created["reportCount"] == 0


def test_renaming_requires_admin(client, db):
    sess = sign_in(client, db)
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=sess.user_id, role="editor"))
    db.commit()
    response = client.patch(f"/api/workspaces/{ws.id}", json={"name": "Renamed"})
    assert response.status_code == 403
    assert response.json()["code"] == "WORKSPACE_FORBIDDEN"


def test_an_admin_may_rename_a_shared_workspace(client, db):
    sign_in(client, db)
    created = client.post("/api/workspaces", json={"name": "Team"}).json()
    renamed = client.patch(f"/api/workspaces/{created['id']}", json={"name": "Finance"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Finance"
    assert renamed.json()["memberCount"] == 1


def test_a_personal_workspace_cannot_be_renamed_or_deleted(client, db):
    """That is what makes it personal, and it is enforced here rather than by
    hiding a button."""
    sign_in(client, db)
    personal = client.get("/api/workspaces").json()["workspaces"][0]
    rename = client.patch(f"/api/workspaces/{personal['id']}", json={"name": "Nope"})
    assert rename.status_code == 400
    assert "personal" in rename.json()["message"].lower()
    assert client.delete(f"/api/workspaces/{personal['id']}").status_code == 400


def test_deleting_a_workspace_deletes_its_reports_and_membership(client, db):
    sign_in(client, db)
    created = client.post("/api/workspaces", json={"name": "Team"}).json()
    client.post(
        "/api/reports",
        json={"definition": valid_definition(), "workspaceId": created["id"]},
    )
    assert db.query(Report).count() == 1

    assert client.delete(f"/api/workspaces/{created['id']}").status_code == 204

    key = uuid.UUID(created["id"])
    assert db.query(Report).filter_by(workspace_id=key).count() == 0
    assert db.query(WorkspaceMember).filter_by(workspace_id=key).count() == 0
    assert db.get(Workspace, key) is None


def test_deleting_a_workspace_leaves_other_workspaces_alone(client, db):
    """The cascade is explicit rather than relying on the FK, so it is worth
    proving it does not over-reach."""
    sign_in(client, db)
    keep = client.post("/api/workspaces", json={"name": "Keep"}).json()
    drop = client.post("/api/workspaces", json={"name": "Drop"}).json()
    client.post(
        "/api/reports",
        json={"definition": valid_definition("Kept"), "workspaceId": keep["id"]},
    )
    client.post(
        "/api/reports",
        json={"definition": valid_definition("Dropped"), "workspaceId": drop["id"]},
    )

    client.delete(f"/api/workspaces/{drop['id']}")

    names = [r["name"] for r in client.get("/api/reports").json()["reports"]]
    assert names == ["Kept"]


def test_only_an_admin_may_delete(client, db):
    sess = sign_in(client, db)
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=sess.user_id, role="editor"))
    db.commit()
    assert client.delete(f"/api/workspaces/{ws.id}").status_code == 403


def test_a_stranger_deleting_a_workspace_gets_404(client, db):
    sign_in(client, db)
    other = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    stranger = Workspace(name="Secret", kind="shared", snowflake_account="ACME")
    db.add(stranger)
    db.flush()
    db.add(
        WorkspaceMember(workspace_id=stranger.id, user_id=other.user_id, role="admin")
    )
    db.commit()
    assert client.delete(f"/api/workspaces/{stranger.id}").status_code == 404


def test_a_workspace_name_is_required(client, db):
    sign_in(client, db)
    assert client.post("/api/workspaces", json={"name": ""}).status_code == 422


def test_a_malformed_workspace_id_is_404(client, db):
    sign_in(client, db)
    assert client.delete("/api/workspaces/not-a-uuid").status_code == 404
