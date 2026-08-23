from app.auth.sessions import create_session
from app.db.models import Report, Workspace, WorkspaceMember
from tests.test_report_routes import sign_in, valid_definition


def _workspace(db, user_id, name, role="editor"):
    ws = Workspace(name=name, kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=user_id, role=role))
    db.commit()
    return ws


def _report(db, workspace, owner_id):
    report = Report(
        owner_user_id=owner_id,
        workspace_id=workspace.id,
        name="R",
        view_database="ANALYTICS",
        view_schema="PUBLIC",
        view_name="SALES",
        definition=valid_definition(),
    )
    db.add(report)
    db.commit()
    return report


def test_moving_a_report_between_two_workspaces_i_can_edit(client, db):
    sess = sign_in(client, db)
    source = _workspace(db, sess.user_id, "Source")
    destination = _workspace(db, sess.user_id, "Destination")
    report = _report(db, source, sess.user_id)

    response = client.post(
        f"/api/reports/{report.id}/move", json={"workspaceId": str(destination.id)}
    )
    assert response.status_code == 200
    assert response.json()["workspaceId"] == str(destination.id)
    assert response.json()["workspaceName"] == "Destination"
    db.refresh(report)
    assert report.workspace_id == destination.id


def test_moving_out_of_a_workspace_i_can_only_read_is_403(client, db):
    """Requiring editor only on the destination would let anyone lift a report
    out of a workspace they were merely shown."""
    sess = sign_in(client, db)
    source = _workspace(db, sess.user_id, "Source", role="viewer")
    destination = _workspace(db, sess.user_id, "Destination", role="editor")
    report = _report(db, source, sess.user_id)

    response = client.post(
        f"/api/reports/{report.id}/move", json={"workspaceId": str(destination.id)}
    )
    assert response.status_code == 403
    db.refresh(report)
    assert report.workspace_id == source.id, "the report must not have moved"


def test_moving_into_a_workspace_i_can_only_read_is_403(client, db):
    """And requiring it only on the source would let anyone push a report into
    a workspace they cannot write to."""
    sess = sign_in(client, db)
    source = _workspace(db, sess.user_id, "Source", role="editor")
    destination = _workspace(db, sess.user_id, "Destination", role="viewer")
    report = _report(db, source, sess.user_id)

    response = client.post(
        f"/api/reports/{report.id}/move", json={"workspaceId": str(destination.id)}
    )
    assert response.status_code == 403
    db.refresh(report)
    assert report.workspace_id == source.id


def test_moving_into_a_workspace_i_do_not_belong_to_is_404(client, db):
    sess = sign_in(client, db)
    source = _workspace(db, sess.user_id, "Source")
    other = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    stranger = _workspace(db, other.user_id, "Theirs", role="admin")
    report = _report(db, source, sess.user_id)

    response = client.post(
        f"/api/reports/{report.id}/move", json={"workspaceId": str(stranger.id)}
    )
    assert response.status_code == 404


def test_moving_a_report_i_cannot_see_is_404(client, db):
    sess = sign_in(client, db)
    destination = _workspace(db, sess.user_id, "Destination")
    other = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    theirs_ws = _workspace(db, other.user_id, "Theirs", role="admin")
    theirs = _report(db, theirs_ws, other.user_id)

    response = client.post(
        f"/api/reports/{theirs.id}/move", json={"workspaceId": str(destination.id)}
    )
    assert response.status_code == 404


def test_moving_to_the_same_workspace_is_a_no_op_not_an_error(client, db):
    sess = sign_in(client, db)
    source = _workspace(db, sess.user_id, "Source")
    report = _report(db, source, sess.user_id)
    response = client.post(
        f"/api/reports/{report.id}/move", json={"workspaceId": str(source.id)}
    )
    assert response.status_code == 200
    db.refresh(report)
    assert report.workspace_id == source.id


def test_a_moved_report_leaves_the_source_listing(client, db):
    sess = sign_in(client, db)
    source = _workspace(db, sess.user_id, "Source")
    destination = _workspace(db, sess.user_id, "Destination")
    report = _report(db, source, sess.user_id)

    client.post(
        f"/api/reports/{report.id}/move", json={"workspaceId": str(destination.id)}
    )

    in_source = client.get("/api/reports", params={"workspace": str(source.id)}).json()
    in_destination = client.get(
        "/api/reports", params={"workspace": str(destination.id)}
    ).json()
    assert in_source["reports"] == []
    assert [r["id"] for r in in_destination["reports"]] == [str(report.id)]


def test_a_malformed_destination_is_404(client, db):
    sess = sign_in(client, db)
    source = _workspace(db, sess.user_id, "Source")
    report = _report(db, source, sess.user_id)
    assert (
        client.post(
            f"/api/reports/{report.id}/move", json={"workspaceId": "not-a-uuid"}
        ).status_code
        == 404
    )
