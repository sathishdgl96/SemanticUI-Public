import uuid

import pytest

from app.auth.sessions import create_session
from app.db.models import Report, User, Workspace, WorkspaceMember
from app.errors import ApiError
from app.workspaces import roles
from app.workspaces.access import membership, require_access, require_workspace
from app.workspaces.service import ensure_personal_workspace


class TestRoleOrder:
    def test_the_ladder_runs_viewer_editor_admin(self):
        assert roles.ROLES == ("viewer", "editor", "admin")

    def test_a_role_satisfies_itself(self):
        for role in roles.ROLES:
            assert roles.at_least(role, role) is True

    def test_a_higher_role_satisfies_a_lower_requirement(self):
        assert roles.at_least("admin", "viewer") is True
        assert roles.at_least("admin", "editor") is True
        assert roles.at_least("editor", "viewer") is True

    def test_a_lower_role_does_not_satisfy_a_higher_requirement(self):
        assert roles.at_least("viewer", "editor") is False
        assert roles.at_least("viewer", "admin") is False
        assert roles.at_least("editor", "admin") is False

    def test_an_unknown_role_satisfies_nothing(self):
        """A garbage value in the column must fail closed, not sort above every
        real role the way a naive string comparison would."""
        assert roles.at_least("superuser", "viewer") is False
        assert roles.at_least("", "viewer") is False
        assert roles.at_least("admin", "root") is False


@pytest.fixture
def world(db):
    """Alice admins a shared workspace holding one report. Bob is outside it."""
    alice = User(snowflake_account="ACME", snowflake_user="ALICE")
    bob = User(snowflake_account="ACME", snowflake_user="BOB")
    db.add_all([alice, bob])
    db.flush()
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=alice.id, role="admin"))
    report = Report(
        owner_user_id=alice.id,
        workspace_id=ws.id,
        name="R",
        view_database="D",
        view_schema="S",
        view_name="V",
        definition={},
    )
    db.add(report)
    db.commit()
    return {"alice": alice, "bob": bob, "ws": ws, "report": report}


class TestRequireAccess:
    def test_a_member_with_a_sufficient_role_gets_the_report(self, db, world):
        got = require_access(
            db, world["alice"].id, str(world["report"].id), need="editor"
        )
        assert got.id == world["report"].id

    def test_a_non_member_gets_404_not_403(self, db, world):
        """404, so a stranger cannot tell "does not exist" from "exists and is
        not yours" -- the same rule the owner-scoped code followed."""
        with pytest.raises(ApiError) as exc:
            require_access(db, world["bob"].id, str(world["report"].id), need="viewer")
        assert exc.value.status == 404

    def test_a_member_with_too_low_a_role_gets_403(self, db, world):
        """403 rather than 404: they are a member, so they already know it
        exists, and a 404 here would be a lie that helps nobody."""
        db.add(
            WorkspaceMember(
                workspace_id=world["ws"].id, user_id=world["bob"].id, role="viewer"
            )
        )
        db.commit()
        with pytest.raises(ApiError) as exc:
            require_access(db, world["bob"].id, str(world["report"].id), need="editor")
        assert exc.value.status == 403
        assert exc.value.code == "WORKSPACE_FORBIDDEN"
        assert "editor" in exc.value.message

    def test_the_owner_of_a_report_still_needs_membership(self, db, world):
        """owner_user_id is provenance, not authorization. Removing someone
        from a workspace must actually remove their access."""
        db.query(WorkspaceMember).filter_by(user_id=world["alice"].id).delete()
        db.commit()
        with pytest.raises(ApiError) as exc:
            require_access(db, world["alice"].id, str(world["report"].id), need="viewer")
        assert exc.value.status == 404

    def test_a_missing_report_is_404(self, db, world):
        with pytest.raises(ApiError) as exc:
            require_access(db, world["alice"].id, str(uuid.uuid4()), need="viewer")
        assert exc.value.status == 404

    def test_a_malformed_report_id_is_404_not_a_crash(self, db, world):
        with pytest.raises(ApiError) as exc:
            require_access(db, world["alice"].id, "not-a-uuid", need="viewer")
        assert exc.value.status == 404


class TestRequireWorkspace:
    def test_a_member_gets_the_workspace(self, db, world):
        got = require_workspace(db, world["alice"].id, str(world["ws"].id), need="admin")
        assert got.id == world["ws"].id

    def test_a_non_member_gets_404(self, db, world):
        with pytest.raises(ApiError) as exc:
            require_workspace(db, world["bob"].id, str(world["ws"].id), need="viewer")
        assert exc.value.status == 404

    def test_a_malformed_workspace_id_is_404(self, db, world):
        with pytest.raises(ApiError) as exc:
            require_workspace(db, world["alice"].id, "nope", need="viewer")
        assert exc.value.status == 404


def test_membership_returns_none_for_a_non_member(db, world):
    assert membership(db, world["bob"].id, world["ws"].id) is None
    assert membership(db, world["alice"].id, world["ws"].id).role == "admin"


class TestPersonalWorkspace:
    def test_signing_in_creates_one(self, db):
        create_session(db, account="ACME", user="ALICE", mode="dev")
        db.commit()
        ws = db.query(Workspace).one()
        assert ws.kind == "personal"
        assert ws.name == "My reports"
        assert ws.snowflake_account == "ACME"
        assert db.query(WorkspaceMember).one().role == "admin"

    def test_signing_in_twice_does_not_create_a_second(self, db):
        create_session(db, account="ACME", user="ALICE", mode="dev")
        db.commit()
        create_session(db, account="ACME", user="ALICE", mode="dev")
        db.commit()
        assert db.query(Workspace).count() == 1

    def test_two_users_get_separate_ones(self, db):
        create_session(db, account="ACME", user="ALICE", mode="dev")
        create_session(db, account="ACME", user="BOB", mode="dev")
        db.commit()
        assert db.query(Workspace).count() == 2

    def test_ensure_is_idempotent(self, db):
        user = User(snowflake_account="ACME", snowflake_user="ALICE")
        db.add(user)
        db.flush()
        first = ensure_personal_workspace(db, user)
        second = ensure_personal_workspace(db, user)
        assert first.id == second.id

    def test_a_shared_membership_does_not_count_as_a_personal_workspace(self, db):
        """Being added to someone else's shared workspace must not leave you
        without a private one of your own."""
        user = User(snowflake_account="ACME", snowflake_user="ALICE")
        db.add(user)
        db.flush()
        shared = Workspace(name="Team", kind="shared", snowflake_account="ACME")
        db.add(shared)
        db.flush()
        db.add(WorkspaceMember(workspace_id=shared.id, user_id=user.id, role="viewer"))
        db.flush()

        personal = ensure_personal_workspace(db, user)
        assert personal.kind == "personal"
        assert personal.id != shared.id
