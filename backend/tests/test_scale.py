"""How the read paths behave as an install grows.

Not a benchmark -- a benchmark on a laptop measures the laptop. These
count QUERIES, which is the thing that turns a fast page into a slow one
when the row count goes up: a listing that costs one query for the list
and two more per row is fine at ten rows and unusable at five hundred.

The target this suite was written against is 500 users. What matters at
that size is not how long any single statement takes but whether the
number of statements grows with the data.
"""

import uuid

import pytest
from sqlalchemy import event

from app.auth.sessions import create_session
from app.db.models import (
    AuditEvent,
    Dashboard,
    Report,
    SavedExplore,
    User,
    Workspace,
    WorkspaceMember,
)


class Counter:
    """Statements issued inside the `with` block."""

    def __init__(self, db):
        self.db = db
        self.statements: list[str] = []

    def __enter__(self):
        self._listen = lambda conn, cursor, statement, *rest: self.statements.append(
            statement
        )
        event.listen(self.db.get_bind(), "before_cursor_execute", self._listen)
        return self

    def __exit__(self, *_):
        event.remove(self.db.get_bind(), "before_cursor_execute", self._listen)

    def __len__(self) -> int:
        return len(self.statements)


def workspace(db, user_id, name="Team", role="admin"):
    ws = Workspace(name=name, kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=user_id, role=role))
    db.commit()
    return ws


def definition(name="R"):
    return {
        "schemaVersion": 3,
        "name": name,
        "view": {"database": "A", "schema": "B", "name": "C"},
        "canvas": {"columns": 12, "rowHeight": 40},
        "filters": [],
        "hierarchies": [],
        "pages": [
            {
                "id": "p1",
                "name": "Page 1",
                "filters": [],
                "visuals": [
                    {
                        "id": "v1",
                        "type": "bar",
                        "title": "T",
                        "layout": {"x": 0, "y": 0, "w": 6, "h": 6},
                        "wells": {"axis": ["C.R"], "values": ["A.V"]},
                        "options": {},
                        "filters": [],
                    }
                ],
            }
        ],
    }


def seed_reports(db, user_id, ws, count):
    for index in range(count):
        db.add(
            Report(
                owner_user_id=user_id,
                workspace_id=ws.id,
                name=f"Report {index:03d}",
                view_database="A",
                view_schema="B",
                view_name="C",
                definition=definition(f"Report {index:03d}"),
            )
        )
    db.commit()


# --- listings --------------------------------------------------------------


@pytest.mark.parametrize("count", [5, 60])
def test_listing_reports_costs_the_same_whatever_the_count(client, db, count):
    """The shape that matters: constant, not merely fast. A per-row
    workspace lookup and a per-row membership lookup are invisible at five
    rows and are 120 extra round trips at sixty."""
    from app.auth.sessions import SESSION_COOKIE

    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    ws = workspace(db, sess.user_id)
    seed_reports(db, sess.user_id, ws, count)

    with Counter(db) as counted:
        assert client.get("/api/reports").status_code == 200
    # Generous: the point is that it does not grow with `count`, not the
    # exact number, which moves when an unrelated query is added.
    assert len(counted) < 25, f"{len(counted)} statements for {count} reports"


def test_listing_dashboards_costs_the_same_whatever_the_count(client, db):
    from app.auth.sessions import SESSION_COOKIE
    from app.dashboards import service as dashboards

    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    ws = workspace(db, sess.user_id)
    for index in range(40):
        dashboards.create_dashboard(db, sess.user_id, f"D{index}", str(ws.id))

    with Counter(db) as counted:
        assert client.get("/api/dashboards").status_code == 200
    assert len(counted) < 25, f"{len(counted)} statements for 40 dashboards"


def test_listing_explores_costs_the_same_whatever_the_count(client, db):
    from app.auth.sessions import SESSION_COOKIE

    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    ws = workspace(db, sess.user_id)
    for index in range(40):
        db.add(
            SavedExplore(
                owner_user_id=sess.user_id,
                workspace_id=ws.id,
                name=f"E{index}",
                view_database="A",
                view_schema="B",
                view_name="C",
                definition={
                    "schemaVersion": 1,
                    "name": f"E{index}",
                    "view": {"database": "A", "schema": "B", "name": "C"},
                    "dimensions": ["C.R"],
                    "metrics": [],
                    "filters": [],
                    "orderBy": [],
                },
            )
        )
    db.commit()

    with Counter(db) as counted:
        assert client.get("/api/explores").status_code == 200
    assert len(counted) < 25, f"{len(counted)} statements for 40 explores"


# --- home ------------------------------------------------------------------


def test_home_does_not_audit_a_denial_just_for_rendering(db):
    """A readability probe is not an authorization decision.

    Recents ran every item through the gate that DECIDES access, and that
    gate writes an audit row on refusal -- so a home page holding items
    somebody had lost access to wrote denials, and committed them, on
    every single page load.
    """
    from app.home import service as home
    from app.library import state

    alice = create_session(db, account="ACME", user="ALICE", mode="dev")
    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    theirs = workspace(db, bob.user_id, "Theirs")
    seed_reports(db, bob.user_id, theirs, 3)
    for report in db.query(Report).all():
        state.record_view(db, alice.user_id, "report", report.id)

    before = db.query(AuditEvent).count()
    assert home.recent_items(db, alice.user_id) == []
    assert db.query(AuditEvent).count() == before


def test_home_recents_cost_a_bounded_number_of_queries(db):
    from app.home import service as home
    from app.library import state

    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    seed_reports(db, sess.user_id, ws, 30)
    for report in db.query(Report).all():
        state.record_view(db, sess.user_id, "report", report.id)

    with Counter(db) as counted:
        assert len(home.recent_items(db, sess.user_id)) == home.RECENT_LIMIT
    assert len(counted) < 15, f"{len(counted)} statements for a recents list"


# --- dashboards ------------------------------------------------------------


def test_a_dashboard_resolves_its_tiles_without_a_gate_per_tile(db):
    """Same defect, same cost: forty tiles meant forty authorization
    decisions, each with its own lookups and its own possible audit
    write, to draw one page."""
    from app.dashboards import service as dashboards

    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    ws = workspace(db, sess.user_id)
    seed_reports(db, sess.user_id, ws, 20)
    made = dashboards.create_dashboard(db, sess.user_id, "Ops", str(ws.id))
    for report in db.query(Report).all():
        dashboards.add_tile(db, sess.user_id, str(made.id), str(report.id), "p1", "v1")

    with Counter(db) as counted:
        assert len(dashboards.detail(db, sess.user_id, made)["tiles"]) == 20
    assert len(counted) < 20, f"{len(counted)} statements for 20 tiles"


# --- the security board ----------------------------------------------------


def test_the_security_board_does_not_read_the_window_into_memory(db):
    """At 500 users a day of events is tens of thousands of rows, and the
    board summarises them into six numbers and fifty rows."""
    from app.admin import service as admin

    user = User(snowflake_account="ACME", snowflake_user="ALICE")
    db.add(user)
    db.commit()
    db.bulk_save_objects(
        [
            AuditEvent(
                id=uuid.uuid4(),
                action="query.run",
                outcome="ok",
                user_id=user.id,
                detail={"rows": 1},
            )
            for _ in range(400)
        ]
    )
    db.commit()

    with Counter(db) as counted:
        out = admin.security(db, hours=24)

    # Bounded output whatever went in.
    assert len(out["recentDenials"]) <= 50
    assert len(out["activity"]) == 24
    # And a bounded number of statements: the counting happens in SQL, so
    # four hundred events cost the same handful of queries as four.
    assert len(counted) < 12, f"{len(counted)} statements to summarise a window"


def test_the_security_board_costs_the_same_at_any_volume(db):
    """The shape that matters: adding events must not add statements."""
    from app.admin import service as admin

    def statements() -> int:
        with Counter(db) as counted:
            admin.security(db, hours=24)
        return len(counted)

    small = statements()
    db.bulk_save_objects(
        [
            AuditEvent(id=uuid.uuid4(), action="query.run", outcome="ok")
            for _ in range(300)
        ]
    )
    db.commit()
    assert statements() == small


# --- bounds ----------------------------------------------------------------


def test_a_listing_is_bounded_and_says_when_it_was(client, db):
    """Not pagination: the merged browse draws from three sources at once
    and a page number across three lists means nothing. A bound and an
    honest "there are more" is the useful half."""
    from app.auth.sessions import SESSION_COOKIE
    from app.library.search import MAX_ROWS

    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    ws = workspace(db, sess.user_id)
    seed_reports(db, sess.user_id, ws, MAX_ROWS + 5)

    body = client.get("/api/reports").json()
    assert len(body["reports"]) == MAX_ROWS
    assert body["truncated"] is True


def test_a_listing_within_the_bound_does_not_claim_to_be_cut_short(client, db):
    from app.auth.sessions import SESSION_COOKIE

    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    ws = workspace(db, sess.user_id)
    seed_reports(db, sess.user_id, ws, 3)

    body = client.get("/api/reports").json()
    assert len(body["reports"]) == 3
    assert body["truncated"] is False


def test_pinned_only_filters_in_the_database(client, db):
    """It used to load every report in the workspace and then discard the
    unpinned ones in Python."""
    from app.auth.sessions import SESSION_COOKIE
    from app.library import state

    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    ws = workspace(db, sess.user_id)
    seed_reports(db, sess.user_id, ws, 40)
    pinned = db.query(Report).order_by(Report.name).first()
    state.set_favorite(db, sess.user_id, "report", pinned.id, True)

    body = client.get("/api/reports?favorite=true").json()
    assert [r["name"] for r in body["reports"]] == [pinned.name]


def test_recently_opened_sorts_pinned_first_then_what_was_opened(client, db):
    from app.auth.sessions import SESSION_COOKIE
    from app.library import state

    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    ws = workspace(db, sess.user_id)
    seed_reports(db, sess.user_id, ws, 4)
    rows = db.query(Report).order_by(Report.name).all()
    state.set_favorite(db, sess.user_id, "report", rows[3].id, True)
    state.record_view(db, sess.user_id, "report", rows[1].id)

    names = [r["name"] for r in client.get("/api/reports").json()["reports"]]
    # Pinned, then opened, then the rest.
    assert names[0] == rows[3].name
    assert names[1] == rows[1].name
