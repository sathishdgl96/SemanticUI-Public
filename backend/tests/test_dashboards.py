"""Dashboards: visuals from several reports on one workspace canvas.

Two properties carry the design, and most of what is below checks one of
them: a tile NAMES a visual rather than copying one, and a tile may not
name a report outside the dashboard's own workspace.
"""

import uuid

import pytest

from app.auth.sessions import SESSION_COOKIE, create_session
from app.dashboards import service
from app.dashboards.schema import MAX_TILES
from app.db.models import Dashboard, Report, User, Workspace, WorkspaceMember
from app.errors import ApiError


def sign_in(client, db, user="ALICE"):
    sess = create_session(db, account="ACME", user=user, mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    return sess


def workspace(db, user_id, name="Team", role="admin"):
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


def dashboard(db, user_id, ws, name="Ops"):
    return service.create_dashboard(db, user_id, name, str(ws.id))


# --- the object ------------------------------------------------------------


def test_a_new_dashboard_is_empty_and_lives_in_its_workspace(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    made = dashboard(db, sess.user_id, ws)
    assert made.workspace_id == ws.id
    assert made.definition["tiles"] == []


def test_a_dashboard_defaults_to_my_personal_workspace(db):
    """The same rule a new report follows."""
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    db.commit()
    made = service.create_dashboard(db, sess.user_id, "Mine", None)
    assert db.get(Workspace, made.workspace_id).kind == "personal"


def test_listing_shows_only_workspaces_i_am_in(db):
    alice = create_session(db, account="ACME", user="ALICE", mode="dev")
    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    mine = workspace(db, alice.user_id, "Mine")
    theirs = workspace(db, bob.user_id, "Theirs")
    dashboard(db, alice.user_id, mine, "Ours")
    dashboard(db, bob.user_id, theirs, "Hidden")

    names = [row["name"] for row in service.list_dashboards(db, alice.user_id, None)]
    assert names == ["Ours"]


def test_someone_elses_dashboard_is_a_404(db):
    alice = create_session(db, account="ACME", user="ALICE", mode="dev")
    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    theirs = workspace(db, bob.user_id, "Theirs")
    made = dashboard(db, bob.user_id, theirs)

    with pytest.raises(ApiError) as raised:
        service.get_dashboard(db, alice.user_id, str(made.id))
    # 404, not 403: a stranger must not learn that this id exists.
    assert raised.value.status == 404


def test_a_viewer_cannot_edit_a_dashboard(db):
    alice = create_session(db, account="ACME", user="ALICE", mode="dev")
    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    ws = workspace(db, bob.user_id, "Team")
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=alice.user_id, role="viewer"))
    db.commit()
    made = dashboard(db, bob.user_id, ws)

    with pytest.raises(ApiError) as raised:
        service.delete_dashboard(db, alice.user_id, str(made.id))
    assert raised.value.status == 403


# --- tiles -----------------------------------------------------------------


def test_a_tile_carries_the_visual_and_the_scopes_around_it(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    row = report(db, sess.user_id, ws)
    made = dashboard(db, sess.user_id, ws)

    tile = service.add_tile(db, sess.user_id, str(made.id), str(row.id), "p1", "v1")
    assert tile["available"] is True
    assert tile["visual"]["title"] == "Revenue by region"
    assert tile["view"]["name"] == "SALES"
    assert tile["reportFilters"][0]["field"] == "C.REGION"
    assert tile["pageFilters"][0]["field"] == "C.SEGMENT"


def test_one_dashboard_gathers_visuals_from_several_reports(db):
    """The whole point of the object: a report binds one semantic view, a
    dashboard binds none and draws from as many reports as it likes."""
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    a = report(db, sess.user_id, ws, name="Revenue", visual_id="v1")
    b = report(db, sess.user_id, ws, name="Churn", visual_id="v2")
    made = dashboard(db, sess.user_id, ws)

    service.add_tile(db, sess.user_id, str(made.id), str(a.id), "p1", "v1")
    service.add_tile(db, sess.user_id, str(made.id), str(b.id), "p1", "v2")

    tiles = service.detail(db, sess.user_id, made)["tiles"]
    assert [tile["reportName"] for tile in tiles] == ["Revenue", "Churn"]


def test_a_tile_may_not_name_a_report_from_another_workspace(db):
    """Without this rule a dashboard could show a report half its members
    cannot open, and every one of them would see a different dashboard."""
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    here = workspace(db, sess.user_id, "Here")
    elsewhere = workspace(db, sess.user_id, "Elsewhere")
    row = report(db, sess.user_id, elsewhere)
    made = dashboard(db, sess.user_id, here)

    with pytest.raises(ApiError) as raised:
        service.add_tile(db, sess.user_id, str(made.id), str(row.id), "p1", "v1")
    assert raised.value.code == "REPORT_OUTSIDE_WORKSPACE"


def test_an_update_re_checks_every_tile_not_only_the_new_one(db):
    """An update is the one place a client could smuggle in a tile naming
    a report outside the workspace."""
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    here = workspace(db, sess.user_id, "Here")
    elsewhere = workspace(db, sess.user_id, "Elsewhere")
    outsider = report(db, sess.user_id, elsewhere)
    made = dashboard(db, sess.user_id, here)

    with pytest.raises(ApiError):
        service.update_dashboard(
            db,
            sess.user_id,
            str(made.id),
            {
                "schemaVersion": 1,
                "name": "Ops",
                "tiles": [
                    {
                        "id": "t1",
                        "reportId": str(outsider.id),
                        "pageId": "p1",
                        "visualId": "v1",
                        "title": None,
                        "layout": {"x": 0, "y": 0, "w": 4, "h": 4},
                    }
                ],
            },
        )


def test_pinning_the_same_visual_twice_is_a_click_on_a_button_already_on(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    row = report(db, sess.user_id, ws)
    made = dashboard(db, sess.user_id, ws)

    first = service.add_tile(db, sess.user_id, str(made.id), str(row.id), "p1", "v1")
    second = service.add_tile(db, sess.user_id, str(made.id), str(row.id), "p1", "v1")
    assert first["id"] == second["id"]
    db.refresh(made)
    assert len(made.definition["tiles"]) == 1


def test_a_new_tile_lands_below_what_is_already_there(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    a = report(db, sess.user_id, ws, name="A", visual_id="v1")
    b = report(db, sess.user_id, ws, name="B", visual_id="v2")
    made = dashboard(db, sess.user_id, ws)

    first = service.add_tile(db, sess.user_id, str(made.id), str(a.id), "p1", "v1")
    second = service.add_tile(db, sess.user_id, str(made.id), str(b.id), "p1", "v2")
    assert second["layout"]["y"] >= first["layout"]["y"] + first["layout"]["h"]


def test_a_dashboard_refuses_to_grow_past_its_cap(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    made = dashboard(db, sess.user_id, ws)
    rows = [
        report(db, sess.user_id, ws, name=f"R{i}", visual_id=f"v{i}")
        for i in range(MAX_TILES + 1)
    ]
    for i in range(MAX_TILES):
        service.add_tile(db, sess.user_id, str(made.id), str(rows[i].id), "p1", f"v{i}")

    with pytest.raises(ApiError) as raised:
        service.add_tile(
            db, sess.user_id, str(made.id), str(rows[MAX_TILES].id), "p1",
            f"v{MAX_TILES}",
        )
    assert raised.value.code == "DASHBOARD_FULL"


def test_removing_a_tile_that_is_not_there_is_a_404(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    made = dashboard(db, sess.user_id, ws)
    with pytest.raises(ApiError) as raised:
        service.remove_tile(db, sess.user_id, str(made.id), "nope")
    assert raised.value.status == 404


def test_an_announcement_is_part_of_the_dashboard_everyone_reads(db):
    """A property of the dashboard, not a per-user message: everyone
    opening it needs the same caveat about what the numbers mean."""
    alice = create_session(db, account="ACME", user="ALICE", mode="dev")
    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    ws = workspace(db, alice.user_id)
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=bob.user_id, role="viewer"))
    db.commit()
    made = dashboard(db, alice.user_id, ws)

    service.update_dashboard(
        db,
        alice.user_id,
        str(made.id),
        {
            "schemaVersion": 1,
            "name": "Ops",
            "announcement": "Q3 figures are provisional until the 5th.",
            "tiles": [],
        },
    )
    assert service.detail(db, bob.user_id, made)["announcement"] == (
        "Q3 figures are provisional until the 5th."
    )


def test_a_new_dashboard_has_no_announcement(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    assert service.detail(db, sess.user_id, dashboard(db, sess.user_id, ws))[
        "announcement"
    ] is None


def test_pinning_does_not_lose_the_announcement(db):
    """add_tile rebuilds the document, and a rebuild that drops a field is
    how a saved note quietly disappears."""
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    row = report(db, sess.user_id, ws)
    made = dashboard(db, sess.user_id, ws)
    service.update_dashboard(
        db,
        sess.user_id,
        str(made.id),
        {"schemaVersion": 1, "name": "Ops", "announcement": "Refreshed at 6am.", "tiles": []},
    )
    service.add_tile(db, sess.user_id, str(made.id), str(row.id), "p1", "v1")
    assert service.detail(db, sess.user_id, made)["announcement"] == "Refreshed at 6am."


def test_an_announcement_longer_than_a_banner_is_refused(db):
    from app.dashboards.schema import ANNOUNCEMENT_MAX

    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    made = dashboard(db, sess.user_id, ws)
    with pytest.raises(ApiError) as raised:
        service.update_dashboard(
            db,
            sess.user_id,
            str(made.id),
            {
                "schemaVersion": 1,
                "name": "Ops",
                "announcement": "x" * (ANNOUNCEMENT_MAX + 1),
                "tiles": [],
            },
        )
    assert raised.value.code == "DASHBOARD_INVALID"


# --- what happens when the source moves ------------------------------------


def test_a_tile_follows_edits_to_its_report(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    row = report(db, sess.user_id, ws)
    made = dashboard(db, sess.user_id, ws)
    service.add_tile(db, sess.user_id, str(made.id), str(row.id), "p1", "v1")

    updated = definition()
    updated["pages"][0]["visuals"][0]["title"] = "Revenue, restated"
    row.definition = updated
    db.commit()

    tiles = service.detail(db, sess.user_id, made)["tiles"]
    assert tiles[0]["visual"]["title"] == "Revenue, restated"


def test_a_tile_whose_visual_was_removed_says_so_rather_than_failing(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    row = report(db, sess.user_id, ws)
    made = dashboard(db, sess.user_id, ws)
    service.add_tile(db, sess.user_id, str(made.id), str(row.id), "p1", "v1")

    stripped = definition()
    stripped["pages"][0]["visuals"] = []
    row.definition = stripped
    db.commit()

    tile = service.detail(db, sess.user_id, made)["tiles"][0]
    assert tile["available"] is False
    assert "no longer on the report" in tile["reason"]


def test_a_tile_whose_report_is_gone_says_so(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    row = report(db, sess.user_id, ws)
    made = dashboard(db, sess.user_id, ws)
    service.add_tile(db, sess.user_id, str(made.id), str(row.id), "p1", "v1")

    from app.reports import service as reports_service

    reports_service.delete_report(db, sess.user_id, str(row.id))

    tile = service.detail(db, sess.user_id, made)["tiles"][0]
    assert tile["available"] is False
    assert tile["reason"] == "This report is no longer available."


def test_a_listing_says_who_made_each_one(db):
    """Browse spans every workspace, so "whose is this" is a column rather
    than something you open the item to find out."""
    alice = create_session(db, account="ACME", user="ALICE", mode="dev")
    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    ws = workspace(db, alice.user_id)
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=bob.user_id, role="editor"))
    db.commit()
    dashboard(db, bob.user_id, ws, "Theirs")

    listed = service.list_dashboards(db, alice.user_id, None)
    assert listed[0]["createdBy"] == "BOB"


def test_a_listing_survives_a_creator_who_is_gone(db):
    """Who made it is a caption, not the reason the row exists."""
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    made = dashboard(db, sess.user_id, ws)
    made.owner_user_id = uuid.uuid4()
    db.commit()

    listed = service.list_dashboards(db, sess.user_id, None)
    assert listed[0]["createdBy"] == ""


# --- the home dashboard ----------------------------------------------------


def test_choosing_a_dashboard_for_home_and_clearing_it(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    made = dashboard(db, sess.user_id, ws)

    assert service.home_dashboard(db, sess.user_id) is None
    service.set_home_dashboard(db, sess.user_id, str(made.id))
    assert service.home_dashboard(db, sess.user_id)["name"] == "Ops"
    service.set_home_dashboard(db, sess.user_id, None)
    assert service.home_dashboard(db, sess.user_id) is None


def test_the_choice_is_per_user(db):
    """Two people in the same workspace reasonably start their day on
    different dashboards."""
    alice = create_session(db, account="ACME", user="ALICE", mode="dev")
    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    ws = workspace(db, alice.user_id)
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=bob.user_id, role="editor"))
    db.commit()
    made = dashboard(db, alice.user_id, ws)

    service.set_home_dashboard(db, alice.user_id, str(made.id))
    assert service.home_dashboard(db, bob.user_id) is None


def test_you_cannot_choose_a_dashboard_you_cannot_read(db):
    alice = create_session(db, account="ACME", user="ALICE", mode="dev")
    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    theirs = workspace(db, bob.user_id, "Theirs")
    made = dashboard(db, bob.user_id, theirs)

    with pytest.raises(ApiError) as raised:
        service.set_home_dashboard(db, alice.user_id, str(made.id))
    assert raised.value.status == 404
    assert db.get(User, alice.user_id).home_dashboard_id is None


def test_losing_access_reads_as_no_dashboard_chosen(db):
    """Not an error, and not a tombstone: the same thing as never having
    chosen, because the page's answer to both is to offer the picker."""
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    made = dashboard(db, sess.user_id, ws)
    service.set_home_dashboard(db, sess.user_id, str(made.id))

    db.query(WorkspaceMember).filter(
        WorkspaceMember.workspace_id == ws.id,
        WorkspaceMember.user_id == sess.user_id,
    ).delete()
    db.commit()

    assert service.home_dashboard(db, sess.user_id) is None


def test_deleting_a_dashboard_clears_it_from_everyones_home(db):
    """A dangling pointer would resolve to "no longer available" on every
    visit, forever."""
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    made = dashboard(db, sess.user_id, ws)
    service.set_home_dashboard(db, sess.user_id, str(made.id))

    service.delete_dashboard(db, sess.user_id, str(made.id))
    assert db.get(User, sess.user_id).home_dashboard_id is None
    assert service.home_dashboard(db, sess.user_id) is None


# --- the endpoints ---------------------------------------------------------


def test_the_dashboard_endpoints_need_a_session(client):
    assert client.get("/api/dashboards").status_code == 401
    assert client.post("/api/dashboards", json={}).status_code == 401
    assert client.put("/api/home/dashboard", json={}).status_code == 401


def test_create_pin_and_read_through_the_endpoints(client, db):
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    row = report(db, sess.user_id, ws)

    made = client.post(
        "/api/dashboards", json={"name": "Ops", "workspaceId": str(ws.id)}
    )
    assert made.status_code == 201
    dashboard_id = made.json()["id"]

    pinned = client.post(
        f"/api/dashboards/{dashboard_id}/tiles",
        json={"reportId": str(row.id), "pageId": "p1", "visualId": "v1"},
    )
    assert pinned.status_code == 201

    body = client.get(f"/api/dashboards/{dashboard_id}").json()
    assert body["tileCount"] == 1
    assert body["tiles"][0]["visual"]["title"] == "Revenue by region"

    assert (
        client.delete(
            f"/api/dashboards/{dashboard_id}/tiles/{pinned.json()['id']}"
        ).status_code
        == 204
    )
    assert client.get(f"/api/dashboards/{dashboard_id}").json()["tiles"] == []


def test_a_tile_layout_outside_the_grid_is_refused(client, db):
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    row = report(db, sess.user_id, ws)
    made = client.post(
        "/api/dashboards", json={"name": "Ops", "workspaceId": str(ws.id)}
    ).json()

    refused = client.put(
        f"/api/dashboards/{made['id']}",
        json={
            "definition": {
                "schemaVersion": 1,
                "name": "Ops",
                "tiles": [
                    {
                        "id": "t1",
                        "reportId": str(row.id),
                        "pageId": "p1",
                        "visualId": "v1",
                        "title": None,
                        "layout": {"x": 99, "y": 0, "w": 4, "h": 4},
                    }
                ],
            }
        },
    )
    assert refused.status_code == 400


def test_deleting_a_dashboard_through_the_endpoint(client, db):
    sess = sign_in(client, db)
    ws = workspace(db, sess.user_id)
    made = client.post(
        "/api/dashboards", json={"name": "Ops", "workspaceId": str(ws.id)}
    ).json()

    assert client.delete(f"/api/dashboards/{made['id']}").status_code == 204
    assert client.get(f"/api/dashboards/{made['id']}").status_code == 404
    assert db.query(Dashboard).count() == 0
