"""The admin area: health, the activity log, and the security board.

The gate is the load-bearing part. Membership comes from the environment,
not the database -- the people who may read everyone's activity are
decided by whoever deploys the app, and a table row granting it would be
a row somebody inside the app could eventually grant themselves.
"""

from datetime import datetime, timedelta, timezone

from app.admin import service
from app.admin.service import FAILED_LOGIN, RATE_LIMITED
from app.audit import record
from app.auth.sessions import SESSION_COOKIE, create_session
from app.db.models import AuditEvent, User


def sign_in(client, db, user="ALICE"):
    sess = create_session(db, account="ACME", user=user, mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    return sess


def admin_client(make_client, db, user="ALICE"):
    client = make_client(SEMANTICUI_AUTH_MODE="dev", SEMANTICUI_APP_ADMINS=f'["{user}"]')
    sign_in(client, db, user)
    return client


# --- the gate --------------------------------------------------------------


def test_an_admin_named_in_the_environment_gets_in(make_client, db):
    client = admin_client(make_client, db)
    assert client.get("/api/admin/health").status_code == 200


def test_everyone_else_is_refused_and_told_why(make_client, db):
    """403 and not 404, unlike a report: there is nothing to hide about
    the existence of an admin area, and an operator left off the list
    needs telling rather than an empty page."""
    client = make_client(SEMANTICUI_AUTH_MODE="dev", SEMANTICUI_APP_ADMINS='["BOB"]')
    sign_in(client, db, "ALICE")
    refused = client.get("/api/admin/events")
    assert refused.status_code == 403
    assert "administrators" in refused.json()["message"]


def test_no_admins_configured_means_nobody(make_client, db):
    client = make_client(SEMANTICUI_AUTH_MODE="dev")
    sign_in(client, db, "ALICE")
    assert client.get("/api/admin/health").status_code == 403


def test_the_admin_list_is_case_insensitive(make_client, db):
    """Snowflake usernames are case-insensitive and stored upper-cased; a
    list typed in any case has to match anyway."""
    client = make_client(SEMANTICUI_AUTH_MODE="dev", SEMANTICUI_APP_ADMINS='["alice"]')
    sign_in(client, db, "ALICE")
    assert client.get("/api/admin/health").status_code == 200


def test_a_refusal_is_itself_audited(make_client, db):
    client = make_client(SEMANTICUI_AUTH_MODE="dev", SEMANTICUI_APP_ADMINS='["BOB"]')
    sign_in(client, db, "ALICE")
    client.get("/api/admin/health")
    denied = db.query(AuditEvent).filter(AuditEvent.action == "admin.denied").all()
    assert len(denied) == 1
    assert denied[0].outcome == "denied"


def test_whoami_answers_for_everyone_without_auditing_a_denial(make_client, db):
    """Every page load asks it to decide whether to draw the admin entry.
    Behind the gate, that would be an audited denial per page view."""
    client = make_client(SEMANTICUI_AUTH_MODE="dev", SEMANTICUI_APP_ADMINS='["BOB"]')
    sign_in(client, db, "ALICE")
    answer = client.get("/api/admin/whoami")
    assert answer.status_code == 200
    assert answer.json() == {"isAppAdmin": False}
    assert db.query(AuditEvent).filter(AuditEvent.action == "admin.denied").count() == 0


def test_the_admin_endpoints_need_a_session(client):
    for path in ("/api/admin/health", "/api/admin/events", "/api/admin/security"):
        assert client.get(path).status_code == 401


# --- health ----------------------------------------------------------------


def test_health_round_trips_the_database_rather_than_reading_the_pool(db):
    """A pool can hold a handle to a server that has stopped answering,
    which is exactly the failure this page exists to catch."""
    out = service.health(db)
    assert out["status"] == "ok"
    database = next(c for c in out["checks"] if c["name"] == "Application database")
    assert database["status"] == "ok"
    assert database["latencyMs"] is not None


def test_health_says_what_the_install_holds(db):
    out = service.health(db)
    assert set(out["counts"]) == {
        "users",
        "workspaces",
        "reports",
        "dashboards",
        "explores",
    }
    assert out["uptimeSeconds"] >= 0


def test_a_database_that_stops_answering_reads_as_down(db, monkeypatch):
    def refuse(*_args, **_kwargs):
        raise RuntimeError("connection reset by peer to postgres://user:pw@host/db")

    monkeypatch.setattr(db, "execute", refuse)
    out = service.health(db)
    assert out["status"] == "down"
    database = next(c for c in out["checks"] if c["name"] == "Application database")
    assert database["status"] == "down"
    # The class, not the message: a driver error can carry a connection
    # string, and this page is read in a browser.
    assert database["detail"] == "RuntimeError"
    assert "postgres://" not in str(out)


# --- the activity log ------------------------------------------------------


def make_user(db, name="ALICE"):
    user = User(snowflake_account="ACME", snowflake_user=name)
    db.add(user)
    db.commit()
    return user


def test_events_come_back_newest_first_with_the_actor_named(db):
    user = make_user(db)
    record(db, "report.read", user_id=user.id, resource_type="report")
    record(db, "report.create", user_id=user.id, resource_type="report")

    out = service.events(db)
    assert [e["action"] for e in out["events"]] == ["report.create", "report.read"]
    assert out["events"][0]["user"] == "ALICE"


def test_events_filter_by_action_outcome_and_user(db):
    alice, bob = make_user(db), make_user(db, "BOB")
    record(db, "report.read", user_id=alice.id)
    record(db, "access.denied", user_id=bob.id, outcome="denied")

    assert len(service.events(db, action="report.read")["events"]) == 1
    assert len(service.events(db, outcome="denied")["events"]) == 1
    assert len(service.events(db, user="bob")["events"]) == 1


def test_an_unknown_user_filter_matches_nothing_rather_than_everything(db):
    user = make_user(db)
    record(db, "report.read", user_id=user.id)
    assert service.events(db, user="NOBODY")["events"] == []


def test_events_page_by_time_rather_than_offset(db):
    """The trail grows while it is being read; an offset would skip or
    repeat rows as it did."""
    user = make_user(db)
    for _ in range(5):
        record(db, "report.read", user_id=user.id)

    first = service.events(db, limit=2)
    assert len(first["events"]) == 2
    assert first["nextBefore"] is not None

    second = service.events(db, limit=2, before=first["nextBefore"])
    assert len(second["events"]) >= 1
    seen = {e["id"] for e in first["events"]} & {e["id"] for e in second["events"]}
    assert seen == set()


def test_the_last_page_says_it_is_the_last(db):
    user = make_user(db)
    record(db, "report.read", user_id=user.id)
    assert service.events(db, limit=50)["nextBefore"] is None


def test_the_action_filter_offers_what_the_trail_actually_holds(db):
    user = make_user(db)
    record(db, "report.read", user_id=user.id)
    record(db, FAILED_LOGIN, user_id=user.id, outcome="failed")
    assert service.events(db)["actions"] == [FAILED_LOGIN, "report.read"]


def test_a_page_size_beyond_the_cap_is_clamped(db):
    user = make_user(db)
    record(db, "report.read", user_id=user.id)
    # Not an error -- a caller asking for a million rows gets the most this
    # endpoint will build, which is what they wanted anyway.
    assert len(service.events(db, limit=10_000)["events"]) == 1


# --- coverage --------------------------------------------------------------

#: Every action the app is expected to record. The list exists so that an
#: endpoint added without a `record` call fails HERE rather than going
#: quietly missing from the trail -- which is exactly how the dashboards,
#: explores, workspace-membership and query paths went unaudited until
#: somebody noticed the log looked thin.
EXPECTED_ACTIONS = {
    # authentication
    "auth.login",
    "auth.login_failed",
    "auth.logout",
    "auth.rate_limited",
    # the things people make
    "report.create", "report.read", "report.update", "report.delete",
    "dashboard.create", "dashboard.read", "dashboard.update", "dashboard.delete",
    "dashboard.tile_add", "dashboard.tile_remove",
    "explore.create", "explore.read", "explore.update", "explore.delete",
    # who may see them
    "workspace.create", "workspace.rename", "workspace.delete",
    "workspace.member_add", "workspace.member_role", "workspace.member_remove",
    # asking the data anything
    "query.run",
    # data leaving, and the machinery that lets it
    "token.mint",
    "feed.read",
    "xmla.session_open",
    # refusals
    "access.denied",
    "admin.denied",
    # preferences worth a line
    "session.context",
    "home.dashboard_set",
}


def test_every_expected_action_is_recorded_somewhere_in_the_app():
    """A grep, deliberately: the alternative is exercising every endpoint
    from here, which would make this a second copy of the whole suite."""
    import pathlib

    app = pathlib.Path(__file__).resolve().parents[1] / "app"
    source = "\n".join(
        path.read_text(encoding="utf-8") for path in app.rglob("*.py")
    )
    missing = sorted(
        action for action in EXPECTED_ACTIONS if f'"{action}"' not in source
    )
    assert missing == [], f"no `record` call writes: {missing}"


def test_the_security_board_only_counts_actions_that_exist():
    """The board matched "auth.failed", which nothing ever wrote, so it
    reported a quiet window through any number of failed sign-ins."""
    unknown = sorted(service.DENIAL_ACTIONS - EXPECTED_ACTIONS)
    assert unknown == [], f"the board watches for actions nobody records: {unknown}"


# --- the security board ----------------------------------------------------


def test_a_quiet_window_says_so_rather_than_showing_nothing(db):
    out = service.security(db)
    assert [a["id"] for a in out["alerts"]] == ["quiet"]
    assert out["alerts"][0]["severity"] == "ok"


def test_failed_sign_ins_raise_an_alert_that_says_what_it_counted(db):
    """An alert you cannot check is an alert you learn to ignore."""
    for _ in range(12):
        record(db, FAILED_LOGIN, outcome="failed", session_id="s1")

    alert = next(a for a in service.security(db)["alerts"] if a["id"] == "auth-failures")
    assert alert["severity"] == "high"
    assert alert["count"] == 12
    assert "12 in the last 24h" in alert["detail"]


def test_a_few_failures_are_information_rather_than_an_alarm(db):
    record(db, FAILED_LOGIN, outcome="failed")
    alert = next(a for a in service.security(db)["alerts"] if a["id"] == "auth-failures")
    assert alert["severity"] == "info"


def test_throttling_is_always_worth_saying(db):
    record(db, RATE_LIMITED, outcome="denied")
    alert = next(a for a in service.security(db)["alerts"] if a["id"] == "rate-limited")
    assert alert["severity"] == "high"


def test_refusals_are_grouped_and_the_worst_offender_named(db):
    bob = make_user(db, "BOB")
    for _ in range(6):
        record(db, "access.denied", user_id=bob.id, outcome="denied")

    out = service.security(db)
    alert = next(a for a in out["alerts"] if a["id"] == "access-denied")
    assert alert["severity"] == "medium"
    assert "BOB" in alert["detail"]
    assert out["recentDenials"][0]["user"] == "BOB"


def test_the_window_excludes_what_is_older_than_it(db):
    user = make_user(db)
    record(db, FAILED_LOGIN, user_id=user.id, outcome="failed")
    old = db.query(AuditEvent).one()
    old.ts = datetime.now(timezone.utc) - timedelta(days=3)
    db.commit()

    assert [a["id"] for a in service.security(db, hours=24)["alerts"]] == ["quiet"]
    assert any(
        a["id"] == "auth-failures" for a in service.security(db, hours=24 * 7)["alerts"]
    )


def test_the_activity_series_has_every_hour_including_the_empty_ones(db):
    """A sparse series drawn as a line implies activity across a gap where
    there was none."""
    series = service.security(db, hours=6)["activity"]
    assert len(series) == 6
    assert all(point["count"] == 0 for point in series)
    # Oldest first, so a chart reads left to right.
    assert series[0]["hour"] < series[-1]["hour"]


def test_the_security_window_is_bounded_by_the_endpoint(make_client, db):
    client = admin_client(make_client, db)
    body = client.get("/api/admin/security?hours=100000").json()
    # An unbounded window would read the whole trail into memory to draw
    # one page.
    assert body["windowHours"] == 24 * 14
