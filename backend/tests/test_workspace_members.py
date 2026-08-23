import uuid

from app.auth.sessions import create_session
from app.db.models import User, Workspace, WorkspaceMember
from tests.test_workspace_routes import sign_in


def a_shared_workspace(client, name="Team"):
    return client.post("/api/workspaces", json={"name": name}).json()


def test_a_new_workspace_has_exactly_one_member_me(client, db):
    sign_in(client, db)
    ws = a_shared_workspace(client)
    members = client.get(f"/api/workspaces/{ws['id']}/members").json()["members"]
    assert len(members) == 1
    assert members[0]["snowflakeUser"] == "ALICE"
    assert members[0]["role"] == "admin"
    assert members[0]["isMe"] is True


def test_adding_a_member_by_snowflake_username(client, db):
    sign_in(client, db)
    ws = a_shared_workspace(client)
    added = client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "BOB", "role": "editor"},
    )
    assert added.status_code == 201
    assert added.json()["snowflakeUser"] == "BOB"
    assert added.json()["role"] == "editor"
    assert added.json()["isMe"] is False


def test_adding_a_member_who_has_never_signed_in_creates_their_user_row(client, db):
    """You cannot require a colleague to log in before you are allowed to
    share with them."""
    sign_in(client, db)
    ws = a_shared_workspace(client)
    assert db.query(User).filter_by(snowflake_user="CAROL").count() == 0
    client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "CAROL", "role": "viewer"},
    )
    assert db.query(User).filter_by(snowflake_user="CAROL").count() == 1


def test_a_new_member_can_immediately_see_the_workspace_reports(client, db):
    """The whole point: membership is what grants access, not ownership."""
    from app.auth.sessions import SESSION_COOKIE
    from tests.test_report_routes import valid_definition

    sign_in(client, db)
    ws = a_shared_workspace(client)
    client.post(
        "/api/reports",
        json={"definition": valid_definition("Shared work"), "workspaceId": ws["id"]},
    )
    client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "BOB", "role": "viewer"},
    )

    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    client.cookies.set(SESSION_COOKIE, bob.id)
    names = [r["name"] for r in client.get("/api/reports").json()["reports"]]
    assert "Shared work" in names


def test_adding_the_same_member_twice_is_rejected(client, db):
    sign_in(client, db)
    ws = a_shared_workspace(client)
    client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "BOB", "role": "viewer"},
    )
    again = client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "BOB", "role": "admin"},
    )
    assert again.status_code == 400
    assert "already" in again.json()["message"].lower()


def test_only_an_admin_may_add_members(client, db):
    sess = sign_in(client, db)
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=sess.user_id, role="editor"))
    db.commit()
    response = client.post(
        f"/api/workspaces/{ws.id}/members",
        json={"snowflakeUser": "BOB", "role": "viewer"},
    )
    assert response.status_code == 403


def test_any_member_may_list_members(client, db):
    """Seeing who else is here is not an admin power -- you need it to know
    who your work is visible to."""
    sess = sign_in(client, db)
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=sess.user_id, role="viewer"))
    db.commit()
    assert client.get(f"/api/workspaces/{ws.id}/members").status_code == 200


def test_a_stranger_may_not_list_members(client, db):
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
    assert client.get(f"/api/workspaces/{stranger.id}/members").status_code == 404


def test_a_personal_workspace_refuses_members(client, db):
    sign_in(client, db)
    personal = client.get("/api/workspaces").json()["workspaces"][0]
    response = client.post(
        f"/api/workspaces/{personal['id']}/members",
        json={"snowflakeUser": "BOB", "role": "viewer"},
    )
    assert response.status_code == 400
    assert "personal" in response.json()["message"].lower()


def test_a_user_from_another_snowflake_account_is_rejected(client, db):
    """Their credentials could never resolve this workspace's views, so the
    grant would be an illusion of access."""
    sign_in(client, db, account="ACME")
    ws = a_shared_workspace(client)
    response = client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={
            "snowflakeUser": "MALLORY",
            "role": "viewer",
            "snowflakeAccount": "OTHERCORP",
        },
    )
    assert response.status_code == 400
    assert "account" in response.json()["message"].lower()


def test_an_unknown_role_is_rejected_at_the_edge(client, db):
    sign_in(client, db)
    ws = a_shared_workspace(client)
    response = client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "BOB", "role": "superuser"},
    )
    assert response.status_code == 422


def test_changing_a_members_role(client, db):
    sign_in(client, db)
    ws = a_shared_workspace(client)
    added = client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "BOB", "role": "viewer"},
    ).json()
    changed = client.patch(
        f"/api/workspaces/{ws['id']}/members/{added['userId']}",
        json={"role": "admin"},
    )
    assert changed.status_code == 200
    assert changed.json()["role"] == "admin"


def test_removing_a_member(client, db):
    sign_in(client, db)
    ws = a_shared_workspace(client)
    added = client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "BOB", "role": "viewer"},
    ).json()
    assert (
        client.delete(
            f"/api/workspaces/{ws['id']}/members/{added['userId']}"
        ).status_code
        == 204
    )
    members = client.get(f"/api/workspaces/{ws['id']}/members").json()["members"]
    assert [m["snowflakeUser"] for m in members] == ["ALICE"]


def test_a_removed_member_loses_access_to_the_reports(client, db):
    """Removal has to actually revoke, not merely hide the workspace."""
    from app.auth.sessions import SESSION_COOKIE
    from tests.test_report_routes import valid_definition

    sign_in(client, db)
    ws = a_shared_workspace(client)
    report_id = client.post(
        "/api/reports",
        json={"definition": valid_definition(), "workspaceId": ws["id"]},
    ).json()["id"]
    added = client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "BOB", "role": "viewer"},
    ).json()

    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    client.cookies.set(SESSION_COOKIE, bob.id)
    assert client.get(f"/api/reports/{report_id}").status_code == 200

    sign_in(client, db)
    client.delete(f"/api/workspaces/{ws['id']}/members/{added['userId']}")

    client.cookies.set(SESSION_COOKIE, bob.id)
    assert client.get(f"/api/reports/{report_id}").status_code == 404


class TestLastAdmin:
    """A workspace with no admin can never have its membership changed again.
    Every route into that state is closed."""

    def test_the_last_admin_cannot_be_removed(self, client, db):
        sign_in(client, db)
        ws = a_shared_workspace(client)
        me = client.get(f"/api/workspaces/{ws['id']}/members").json()["members"][0]
        response = client.delete(f"/api/workspaces/{ws['id']}/members/{me['userId']}")
        assert response.status_code == 400
        assert "last admin" in response.json()["message"].lower()

    def test_the_last_admin_cannot_be_demoted(self, client, db):
        sign_in(client, db)
        ws = a_shared_workspace(client)
        me = client.get(f"/api/workspaces/{ws['id']}/members").json()["members"][0]
        response = client.patch(
            f"/api/workspaces/{ws['id']}/members/{me['userId']}",
            json={"role": "editor"},
        )
        assert response.status_code == 400
        assert "last admin" in response.json()["message"].lower()

    def test_an_admin_may_leave_once_another_admin_exists(self, client, db):
        sign_in(client, db)
        ws = a_shared_workspace(client)
        me = client.get(f"/api/workspaces/{ws['id']}/members").json()["members"][0]
        client.post(
            f"/api/workspaces/{ws['id']}/members",
            json={"snowflakeUser": "BOB", "role": "admin"},
        )
        assert (
            client.delete(
                f"/api/workspaces/{ws['id']}/members/{me['userId']}"
            ).status_code
            == 204
        )

    def test_demoting_one_of_two_admins_is_allowed(self, client, db):
        sign_in(client, db)
        ws = a_shared_workspace(client)
        added = client.post(
            f"/api/workspaces/{ws['id']}/members",
            json={"snowflakeUser": "BOB", "role": "admin"},
        ).json()
        assert (
            client.patch(
                f"/api/workspaces/{ws['id']}/members/{added['userId']}",
                json={"role": "viewer"},
            ).status_code
            == 200
        )

    def test_promoting_the_last_admin_to_admin_is_a_no_op_not_an_error(self, client, db):
        """Setting the role they already hold must not trip the guard."""
        sign_in(client, db)
        ws = a_shared_workspace(client)
        me = client.get(f"/api/workspaces/{ws['id']}/members").json()["members"][0]
        assert (
            client.patch(
                f"/api/workspaces/{ws['id']}/members/{me['userId']}",
                json={"role": "admin"},
            ).status_code
            == 200
        )


def test_removing_someone_who_is_not_a_member_is_404(client, db):
    sign_in(client, db)
    ws = a_shared_workspace(client)
    assert (
        client.delete(f"/api/workspaces/{ws['id']}/members/{uuid.uuid4()}").status_code
        == 404
    )


def test_a_malformed_member_id_is_404(client, db):
    sign_in(client, db)
    ws = a_shared_workspace(client)
    assert (
        client.delete(f"/api/workspaces/{ws['id']}/members/nope").status_code == 404
    )
