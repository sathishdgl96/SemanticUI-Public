"""First-run orientation: which advice a new person gets, and when.

The branch exists because advice you cannot act on teaches people to stop
reading. Telling a viewer in somebody else's workspace to build a report is
exactly that, so what the user can already see decides what they are told.
"""

import uuid

import pytest

from app.db.models import (
    Dashboard,
    User,
    Workspace,
    WorkspaceMember,
)
from app.home import welcome


@pytest.fixture
def user(db) -> User:
    row = User(id=uuid.uuid4(), snowflake_account="acct", snowflake_user="ada")
    db.add(row)
    db.commit()
    return row


def a_workspace(db, user: User, role: str, *, populated: bool) -> Workspace:
    ws = Workspace(
        id=uuid.uuid4(), name="Revenue", kind="shared", snowflake_account="acct"
    )
    db.add(ws)
    db.add(WorkspaceMember(
        id=uuid.uuid4(), workspace_id=ws.id, user_id=user.id, role=role
    ))
    if populated:
        db.add(Dashboard(
            id=uuid.uuid4(), workspace_id=ws.id, owner_user_id=user.id,
            name="Weekly", definition={},
        ))
    db.commit()
    return ws


def test_somebody_with_nothing_is_pointed_at_a_model(db, user):
    block = welcome.build(db, user)

    assert block["path"] == "explore"
    assert block["seen"] is False


def test_membership_of_an_empty_workspace_is_still_a_standing_start(db, user):
    # What they can SEE is the question, not what they belong to. A workspace
    # with nothing in it teaches nothing.
    a_workspace(db, user, "editor", populated=False)

    assert welcome.build(db, user)["path"] == "explore"


def test_somebody_dropped_into_a_populated_workspace_is_pointed_at_it(db, user):
    a_workspace(db, user, "viewer", populated=True)

    block = welcome.build(db, user)

    assert block["path"] == "team"


def test_a_viewer_is_not_told_to_build_a_report(db, user):
    a_workspace(db, user, "viewer", populated=True)

    assert welcome.build(db, user)["canAuthor"] is False


def test_an_editor_is_told_how_to_build_one(db, user):
    a_workspace(db, user, "editor", populated=True)

    assert welcome.build(db, user)["canAuthor"] is True


def test_being_welcomed_once_is_remembered(db, user):
    welcome.dismiss(db, user)

    assert welcome.build(db, user)["seen"] is True


def test_dismissing_twice_is_harmless(db, user):
    welcome.dismiss(db, user)
    first = user.welcomed_at
    welcome.dismiss(db, user)

    # Idempotent: a retried request must not restamp the moment somebody was
    # oriented, which is the one thing this column is for.
    assert user.welcomed_at == first


# --- Over HTTP -------------------------------------------------------------


def sign_in(client, db):
    from app.auth.sessions import SESSION_COOKIE, create_session

    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    return sess


def test_the_welcome_block_rides_on_the_home_payload(client, db):
    # No second round trip: Home already answers in one request, and asking
    # separately would stagger the one moment this block exists for.
    sign_in(client, db)

    body = client.get("/api/home").json()

    assert body["welcome"]["seen"] is False
    assert body["welcome"]["path"] == "explore"


def test_dismissing_is_remembered_across_requests(client, db):
    sign_in(client, db)

    assert client.post("/api/home/welcome/dismiss").status_code == 204

    assert client.get("/api/home").json()["welcome"]["seen"] is True


def test_dismissing_requires_auth(client):
    assert client.post("/api/home/welcome/dismiss").status_code == 401
