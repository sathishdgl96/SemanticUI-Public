"""The home page: what you opened lately, and what you pinned.

The load-bearing property throughout is that a widget NAMES a visual
rather than copying one -- so every read re-resolves it through the same
authorization gate as opening the report, and a report you can no longer
see takes its widgets with it.
"""

import uuid

from app.auth.sessions import SESSION_COOKIE, create_session
from app.db.models import HomeWidget, Report, Workspace, WorkspaceMember
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
    assert len(recent) == service.RECENT_LIMIT == 10
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


# --- pinning ---------------------------------------------------------------


def test_pinning_resolves_the_visual_and_the_scopes_around_it(db):
    """A widget carries the report's own filters, or it would show a
    different number from the report it came from."""
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    row = report(db, sess.user_id, ws)

    widget = service.pin(db, sess.user_id, str(row.id), "p1", "v1")
    assert widget["available"] is True
    assert widget["visual"]["title"] == "Revenue by region"
    assert widget["view"] == {
        "database": "ANALYTICS",
        "schema": "PUBLIC",
        "name": "SALES",
    }
    assert widget["reportFilters"][0]["field"] == "C.REGION"
    assert widget["pageFilters"][0]["field"] == "C.SEGMENT"
    assert widget["reportName"] == "Sales"


def test_pinning_twice_is_a_click_on_a_button_already_on(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    row = report(db, sess.user_id, ws)

    first = service.pin(db, sess.user_id, str(row.id), "p1", "v1")
    second = service.pin(db, sess.user_id, str(row.id), "p1", "v1")
    assert first["id"] == second["id"]
    assert db.query(HomeWidget).count() == 1


def test_a_new_widget_lands_below_what_is_already_there(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    a = report(db, sess.user_id, ws, name="A", visual_id="v1")
    b = report(db, sess.user_id, ws, name="B", visual_id="v2")

    first = service.pin(db, sess.user_id, str(a.id), "p1", "v1")
    second = service.pin(db, sess.user_id, str(b.id), "p1", "v2")
    assert second["layout"]["y"] >= first["layout"]["y"] + first["layout"]["h"]


def test_pinning_a_visual_that_is_not_on_the_report_is_a_404(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    row = report(db, sess.user_id, ws)

    import pytest

    from app.errors import ApiError

    with pytest.raises(ApiError) as raised:
        service.pin(db, sess.user_id, str(row.id), "p1", "nope")
    assert raised.value.status == 404


def test_you_cannot_pin_a_report_you_cannot_read(db):
    alice = create_session(db, account="ACME", user="ALICE", mode="dev")
    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    theirs = workspace(db, bob.user_id, "Theirs", role="admin")
    row = report(db, bob.user_id, theirs, name="Private")

    import pytest

    from app.errors import ApiError

    with pytest.raises(ApiError) as raised:
        service.pin(db, alice.user_id, str(row.id), "p1", "v1")
    # 404, not 403: a stranger must not learn that this id exists.
    assert raised.value.status == 404


# --- what happens when the source moves ------------------------------------


def test_a_widget_follows_edits_to_the_report(db):
    """The point of naming rather than copying: retitle the visual on the
    report and the widget says the new title."""
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    row = report(db, sess.user_id, ws)
    service.pin(db, sess.user_id, str(row.id), "p1", "v1")

    updated = definition()
    updated["pages"][0]["visuals"][0]["title"] = "Revenue, restated"
    row.definition = updated
    db.commit()

    assert service.list_widgets(db, sess.user_id)[0]["visual"]["title"] == (
        "Revenue, restated"
    )


def test_a_widget_whose_visual_was_removed_says_so_rather_than_failing(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    row = report(db, sess.user_id, ws)
    service.pin(db, sess.user_id, str(row.id), "p1", "v1")

    stripped = definition()
    stripped["pages"][0]["visuals"] = []
    row.definition = stripped
    db.commit()

    widget = service.list_widgets(db, sess.user_id)[0]
    assert widget["available"] is False
    assert "no longer on the report" in widget["reason"]


def test_losing_access_to_the_report_loses_the_widget_with_it(db):
    """The same answer as a deleted report, deliberately: telling the two
    apart would tell a former member the report still exists."""
    alice = create_session(db, account="ACME", user="ALICE", mode="dev")
    db.commit()
    ws = workspace(db, alice.user_id, role="admin")
    row = report(db, alice.user_id, ws)
    service.pin(db, alice.user_id, str(row.id), "p1", "v1")
    assert service.list_widgets(db, alice.user_id)[0]["available"] is True

    db.query(WorkspaceMember).filter(
        WorkspaceMember.workspace_id == ws.id,
        WorkspaceMember.user_id == alice.user_id,
    ).delete()
    db.commit()

    widget = service.list_widgets(db, alice.user_id)[0]
    assert widget["available"] is False
    assert widget["reason"] == "This report is no longer available."


def test_deleting_a_report_takes_its_widgets_away(db):
    """The reference carries no foreign key, so nothing else will."""
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id, role="admin")
    row = report(db, sess.user_id, ws)
    service.pin(db, sess.user_id, str(row.id), "p1", "v1")

    from app.reports import service as reports_service

    reports_service.delete_report(db, sess.user_id, str(row.id))
    assert service.list_widgets(db, sess.user_id) == []


# --- unpin and rearrange ---------------------------------------------------


def test_unpinning_someone_elses_widget_is_a_404(db):
    alice = create_session(db, account="ACME", user="ALICE", mode="dev")
    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    ws = workspace(db, bob.user_id, "Theirs", role="admin")
    row = report(db, bob.user_id, ws)
    theirs = service.pin(db, bob.user_id, str(row.id), "p1", "v1")

    import pytest

    from app.errors import ApiError

    with pytest.raises(ApiError) as raised:
        service.unpin(db, alice.user_id, theirs["id"])
    assert raised.value.status == 404
    assert db.query(HomeWidget).count() == 1


def test_rearranging_writes_the_grid_back_and_ignores_ids_that_are_not_mine(db):
    alice = create_session(db, account="ACME", user="ALICE", mode="dev")
    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    ws = workspace(db, alice.user_id, role="admin")
    row = report(db, alice.user_id, ws)
    mine = service.pin(db, alice.user_id, str(row.id), "p1", "v1")

    theirs_ws = workspace(db, bob.user_id, "Theirs", role="admin")
    theirs_report = report(db, bob.user_id, theirs_ws, name="Theirs")
    theirs = service.pin(db, bob.user_id, str(theirs_report.id), "p1", "v1")

    service.rearrange(
        db,
        alice.user_id,
        [
            {"id": mine["id"], "x": 3, "y": 2, "w": 5, "h": 4},
            {"id": theirs["id"], "x": 9, "y": 9, "w": 1, "h": 1},
            {"id": "not-a-uuid", "x": 1, "y": 1, "w": 1, "h": 1},
        ],
    )

    assert service.list_widgets(db, alice.user_id)[0]["layout"] == {
        "x": 3,
        "y": 2,
        "w": 5,
        "h": 4,
    }
    assert service.list_widgets(db, bob.user_id)[0]["layout"]["x"] == 0


# --- the endpoints ---------------------------------------------------------


def test_home_returns_both_halves_in_one_request(client, db):
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    row = report(db, sess.user_id, ws)
    state.record_view(db, sess.user_id, "report", row.id)

    created = client.post(
        "/api/home/widgets",
        json={"reportId": str(row.id), "pageId": "p1", "visualId": "v1"},
    )
    assert created.status_code == 201

    body = client.get("/api/home").json()
    assert [item["name"] for item in body["recent"]] == ["Sales"]
    assert len(body["widgets"]) == 1
    assert body["widgets"][0]["available"] is True


def test_the_home_endpoints_need_a_session(client):
    assert client.get("/api/home").status_code == 401
    assert client.post("/api/home/widgets", json={}).status_code == 401


def test_unpinning_through_the_endpoint_removes_it(client, db):
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    row = report(db, sess.user_id, ws)
    widget = client.post(
        "/api/home/widgets",
        json={"reportId": str(row.id), "pageId": "p1", "visualId": "v1"},
    ).json()

    assert client.delete(f"/api/home/widgets/{widget['id']}").status_code == 204
    assert client.get("/api/home").json()["widgets"] == []


def test_a_layout_entry_outside_the_grid_is_refused(client, db):
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    row = report(db, sess.user_id, ws)
    widget = client.post(
        "/api/home/widgets",
        json={"reportId": str(row.id), "pageId": "p1", "visualId": "v1"},
    ).json()

    over = client.patch(
        "/api/home/widgets",
        json={"layouts": [{"id": widget["id"], "x": 0, "y": 0, "w": 99, "h": 1}]},
    )
    assert over.status_code == 422
