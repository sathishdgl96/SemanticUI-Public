"""Deployment-wide notices.

They used to be a field on a dashboard, which made a broadcast to
everybody something you had to open one dashboard to read -- and made
writing one a thing any workspace editor could do. Both halves of that
are what these check.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.announcements import service
from app.auth.sessions import SESSION_COOKIE, create_session
from app.db.models import Announcement, AuditEvent, User
from app.errors import ApiError


def sign_in(client, db, user="ALICE"):
    sess = create_session(db, account="ACME", user=user, mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    return sess


def admin_client(make_client, db, user="ALICE"):
    client = make_client(SEMANTICUI_AUTH_MODE="dev", SEMANTICUI_APP_ADMINS=f'["{user}"]')
    sign_in(client, db, user)
    return client


def make_user(db, name="ALICE"):
    user = User(snowflake_account="ACME", snowflake_user=name)
    db.add(user)
    db.commit()
    return user


def now():
    return datetime.now(timezone.utc)


# --- who may write one -----------------------------------------------------


def test_only_an_administrator_may_write_one(make_client, db):
    """A notice shown to every user is not a permission any row in this
    database should be able to grant."""
    client = make_client(SEMANTICUI_AUTH_MODE="dev", SEMANTICUI_APP_ADMINS='["BOB"]')
    sign_in(client, db, "ALICE")

    assert client.post("/api/announcements", json={"message": "hi"}).status_code == 405
    refused = client.post("/api/admin/announcements", json={"message": "hi"})
    assert refused.status_code == 403
    assert db.query(Announcement).count() == 0


def test_everybody_may_read_what_is_showing(client, db):
    sign_in(client, db)
    assert client.get("/api/announcements").json() == {"announcements": []}


def test_reading_still_needs_a_session(client):
    assert client.get("/api/announcements").status_code == 401


def test_an_administrator_writes_and_everyone_sees_it(make_client, db):
    admin = admin_client(make_client, db, "ALICE")
    made = admin.post(
        "/api/admin/announcements",
        json={"message": "Snowflake maintenance on Saturday.", "level": "warning"},
    )
    assert made.status_code == 201

    reader = make_client(SEMANTICUI_AUTH_MODE="dev")
    sign_in(reader, db, "BOB")
    showing = reader.get("/api/announcements").json()["announcements"]
    assert [a["message"] for a in showing] == ["Snowflake maintenance on Saturday."]
    assert showing[0]["createdBy"] == "ALICE"


def test_writing_one_is_audited(make_client, db):
    admin = admin_client(make_client, db)
    admin.post("/api/admin/announcements", json={"message": "hello", "level": "info"})
    written = db.query(AuditEvent).filter(
        AuditEvent.action == "announcement.create"
    ).all()
    assert len(written) == 1
    # A shape, not the message: the trail's contract holds here too.
    assert written[0].detail == {"level": "info"}


# --- what is showing -------------------------------------------------------


def test_a_notice_that_has_not_started_is_not_showing_yet(db):
    user = make_user(db)
    service.create(db, user.id, "Later", starts_at=now() + timedelta(hours=2))
    assert service.live(db) == []
    # But its author can see it waiting.
    assert len(service.listing(db)) == 1


def test_a_notice_that_has_ended_stops_showing(db):
    user = make_user(db)
    service.create(
        db,
        user.id,
        "Done",
        starts_at=now() - timedelta(hours=3),
        ends_at=now() - timedelta(hours=1),
    )
    assert service.live(db) == []


def test_an_open_ended_notice_keeps_showing(db):
    """Right for a standing notice and wrong for a maintenance window,
    which is why both are offered."""
    user = make_user(db)
    service.create(db, user.id, "Standing", ends_at=None)
    assert [a["message"] for a in service.live(db)] == ["Standing"]


def test_switching_one_off_takes_it_down_without_deleting_it(db):
    user = make_user(db)
    made = service.create(db, user.id, "Oops")
    service.update(db, made["id"], active=False)
    assert service.live(db) == []
    assert len(service.listing(db)) == 1


def test_the_loudest_notice_is_read_first(db):
    """A critical notice under two informational ones is a critical
    notice somebody scrolled past."""
    user = make_user(db)
    service.create(db, user.id, "FYI", level="info")
    service.create(db, user.id, "Careful", level="warning")
    service.create(db, user.id, "Down", level="critical")
    assert [a["level"] for a in service.live(db)] == ["critical", "warning", "info"]


def test_the_banner_is_not_a_feed(db):
    """More than a few and nobody reads any of them."""
    user = make_user(db)
    for index in range(9):
        service.create(db, user.id, f"Notice {index}")
    assert len(service.live(db)) == 5


# --- what a notice may say -------------------------------------------------


def test_a_notice_needs_something_to_say(db):
    user = make_user(db)
    with pytest.raises(ApiError) as raised:
        service.create(db, user.id, "   ")
    assert raised.value.status == 400


def test_a_notice_longer_than_a_banner_is_refused(db):
    user = make_user(db)
    with pytest.raises(ApiError):
        service.create(db, user.id, "x" * (service.MAX_MESSAGE + 1))


def test_a_level_nobody_defined_is_refused(db):
    """The level reaches a class name; it is not a value a caller
    invents."""
    user = make_user(db)
    with pytest.raises(ApiError):
        service.create(db, user.id, "hello", level="shouty")


# --- editing ---------------------------------------------------------------


def test_editing_changes_what_everyone_reads(db):
    user = make_user(db)
    made = service.create(db, user.id, "First wording")
    service.update(db, made["id"], message="Second wording")
    assert [a["message"] for a in service.live(db)] == ["Second wording"]


def test_an_end_can_be_cleared_as_well_as_moved(db):
    """Absent means "leave it"; clearing is a different instruction."""
    user = make_user(db)
    made = service.create(db, user.id, "Window", ends_at=now() + timedelta(hours=1))
    service.update(db, made["id"], clear_end=True)
    assert service.listing(db)[0]["endsAt"] is None


def test_deleting_one_removes_it(make_client, db):
    admin = admin_client(make_client, db)
    made = admin.post("/api/admin/announcements", json={"message": "temp"}).json()
    assert admin.delete(f"/api/admin/announcements/{made['id']}").status_code == 204
    assert db.query(Announcement).count() == 0


def test_editing_something_that_is_not_there_is_a_404(db):
    import uuid

    with pytest.raises(ApiError) as raised:
        service.update(db, str(uuid.uuid4()), message="x")
    assert raised.value.status == 404

    with pytest.raises(ApiError) as raised:
        service.update(db, "not-a-uuid", message="x")
    assert raised.value.status == 404
