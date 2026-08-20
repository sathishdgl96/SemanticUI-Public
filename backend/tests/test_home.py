"""Home: the last few things you opened.

The other half of Home -- the dashboard a user chose to open on -- is
tested in test_dashboards.py, because it is a dashboard first and a home
page second.
"""

import uuid

from app.auth.sessions import SESSION_COOKIE, create_session
from app.db.models import Report, Workspace, WorkspaceMember
from app.home import service
from app.library import state


def sign_in(client, db, user="ALICE"):
    sess = create_session(db, account="ACME", user=user, mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    return sess


def workspace(db, user_id, name="Team", role="editor"):
    ws = Workspace(name=name, kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=user_id, role=role))
    db.commit()
    return ws


def definition(name="Sales", visual_id="v1", page_id="p1"):
    return {
        "schemaVersion": 3,
        "name": name,
        "view": {"database": "ANALYTICS", "schema": "PUBLIC", "name": "SALES"},
        "canvas": {"columns": 12, "rowHeight": 40},
        "filters": [{"id": "f1", "field": "C.REGION", "op": "is", "values": ["EU"]}],
        "hierarchies": [],
        "pages": [
            {
                "id": page_id,
                "name": "Page 1",
                "filters": [
                    {"id": "f2", "field": "C.SEGMENT", "op": "is", "values": ["SMB"]}
                ],
                "visuals": [
                    {
                        "id": visual_id,
                        "type": "bar",
                        "title": "Revenue by region",
                        "layout": {"x": 0, "y": 0, "w": 6, "h": 6},
                        "wells": {"axis": ["C.REGION"], "values": ["A.REV"]},
                        "options": {},
                        "filters": [],
                    }
                ],
            }
        ],
    }


def report(db, user_id, ws, name="Sales", **kwargs):
    row = Report(
        owner_user_id=user_id,
        workspace_id=ws.id,
        name=name,
        view_database="ANALYTICS",
        view_schema="PUBLIC",
        view_name="SALES",
        definition=definition(name=name, **kwargs),
    )
    db.add(row)
    db.commit()
    return row


# --- recents ---------------------------------------------------------------


def test_recents_are_newest_first_and_capped(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    made = [report(db, sess.user_id, ws, name=f"R{i}") for i in range(12)]
    for row in made:
        state.record_view(db, sess.user_id, "report", row.id)

    recent = service.recent_items(db, sess.user_id)
    # Five, not ten: Home leads with recents and gives the rest of the page
    # to a dashboard.
    assert len(recent) == service.RECENT_LIMIT == 5
    # Last opened is first read.
    assert recent[0]["name"] == "R11"
    assert recent[0]["itemType"] == "report"


def test_recents_leave_out_what_this_user_may_no_longer_open(db):
    """A recent entry records that you opened it, not that you may again.

    Removed from the workspace, the row still exists and the state row
    still points at it -- and the list must not."""
    alice = create_session(db, account="ACME", user="ALICE", mode="dev")
    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    theirs = workspace(db, bob.user_id, "Theirs", role="admin")
    row = report(db, bob.user_id, theirs, name="Private")
    state.record_view(db, alice.user_id, "report", row.id)

    assert service.recent_items(db, alice.user_id) == []


def test_recents_survive_an_item_that_was_deleted_under_them(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    kept = report(db, sess.user_id, ws, name="Kept")
    state.record_view(db, sess.user_id, "report", kept.id)
    state.record_view(db, sess.user_id, "report", uuid.uuid4())

    recent = service.recent_items(db, sess.user_id)
    assert [item["name"] for item in recent] == ["Kept"]


def test_home_returns_recents_and_the_chosen_dashboard(client, db):
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id, role="admin")
    row = report(db, sess.user_id, ws)
    state.record_view(db, sess.user_id, "report", row.id)

    body = client.get("/api/home").json()
    assert [item["name"] for item in body["recent"]] == ["Sales"]
    # Nothing chosen yet -- the page offers to choose one.
    assert body["dashboard"] is None

    created = client.post(
        "/api/dashboards", json={"name": "Ops", "workspaceId": str(ws.id)}
    ).json()
    client.put("/api/home/dashboard", json={"dashboardId": created["id"]})

    body = client.get("/api/home").json()
    assert body["dashboard"]["name"] == "Ops"


def test_home_needs_a_session(client):
    assert client.get("/api/home").status_code == 401


def test_home_carries_the_dashboards_announcement(client, db):
    """It is shown on Home, so it has to travel there -- the payload is
    the only route it has."""
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id, role="admin")
    made = client.post(
        "/api/dashboards", json={"name": "Ops", "workspaceId": str(ws.id)}
    ).json()
    client.put(
        f"/api/dashboards/{made['id']}",
        json={
            "definition": {
                "schemaVersion": 1,
                "name": "Ops",
                "announcement": "Refreshed at 6am.",
                "tiles": [],
            }
        },
    )
    client.put("/api/home/dashboard", json={"dashboardId": made["id"]})

    body = client.get("/api/home").json()
    assert body["dashboard"]["announcement"] == "Refreshed at 6am."
