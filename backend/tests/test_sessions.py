from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.auth.crypto import decrypt_token
from app.auth.sessions import (
    create_session,
    delete_session,
    get_active_session,
    new_session_id,
    purge_expired_sessions,
)
from app.db.models import DbSession, User


def test_session_ids_are_long_random():
    a, b = new_session_id(), new_session_id()
    assert a != b
    assert len(a) >= 40


def test_create_session_upserts_user_and_encrypts_tokens(db):
    s1 = create_session(
        db, account="ACME", user="ALICE", mode="oauth",
        access_token="at-1", refresh_token="rt-1",
        access_expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )
    s2 = create_session(db, account="ACME", user="ALICE", mode="dev")
    users = db.scalars(select(User)).all()
    assert len(users) == 1
    assert s1.user_id == s2.user_id
    assert decrypt_token(s1.access_token_enc) == "at-1"
    assert s2.access_token_enc is None


def test_get_active_session_touches_and_expires(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    before = sess.last_seen_at
    found = get_active_session(db, sess.id)
    assert found is not None and found.last_seen_at >= before

    sess.last_seen_at = datetime.now(timezone.utc) - timedelta(hours=9)
    db.commit()
    assert get_active_session(db, sess.id) is None
    assert get_active_session(db, "nonsense") is None


def test_purge_expired_sessions_deletes_only_stale_rows(db):
    fresh = create_session(db, account="ACME", user="ALICE", mode="dev")
    stale = create_session(
        db, account="ACME", user="BOB", mode="oauth",
        access_token="at-1", refresh_token="rt-1",
        access_expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )
    stale.last_seen_at = datetime.now(timezone.utc) - timedelta(hours=9)
    db.commit()

    count = purge_expired_sessions(db)

    assert count == 1
    assert db.get(DbSession, stale.id) is None
    assert db.get(DbSession, fresh.id) is not None


def test_purge_expired_sessions_is_noop_when_nothing_stale(db):
    create_session(db, account="ACME", user="ALICE", mode="dev")
    assert purge_expired_sessions(db) == 0


def test_delete_session(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    delete_session(db, sess.id)
    assert get_active_session(db, sess.id) is None


def test_get_active_session_survives_concurrent_delete(db_factory):
    """Test that get_active_session handles concurrent deletion by another session.

    This reproduces the cross-session staleness scenario where one session creates
    a session, another deletes it, and the original session queries it.
    The test verifies that the original session is still usable after the failed query.
    """
    # Session A: create the session
    db_a = db_factory()
    sess = create_session(db_a, account="ACME", user="ALICE", mode="dev")
    sess_id = sess.id

    # Session B: delete the row
    db_b = db_factory()
    sess_b = db_b.get(__import__('app.db.models', fromlist=['DbSession']).DbSession, sess_id)
    assert sess_b is not None
    db_b.delete(sess_b)
    db_b.commit()
    db_b.close()

    # Session A: query the deleted session and verify it returns None
    result = get_active_session(db_a, sess_id)
    assert result is None

    # CRITICAL: verify Session A is still usable (no PendingRollbackError)
    from app.db.models import User
    users = db_a.scalars(select(User)).all()
    assert isinstance(users, list)

    db_a.close()


def test_expired_session_survives_concurrent_delete(db_factory):
    """Test that expired session handling survives concurrent deletion by another session.

    This reproduces the TTL-expiry branch race condition where one session
    sets a session to expired while another deletes it concurrently.
    """
    # Session A: create the session with old timestamp
    db_a = db_factory()
    sess = create_session(db_a, account="ACME", user="ALICE", mode="dev")
    sess_id = sess.id

    # Make session old enough to expire (9 hours ago)
    sess.last_seen_at = datetime.now(timezone.utc) - timedelta(hours=9)
    db_a.commit()

    # Session B: delete the row before Session A tries to expire it
    db_b = db_factory()
    sess_b = db_b.get(__import__('app.db.models', fromlist=['DbSession']).DbSession, sess_id)
    assert sess_b is not None
    db_b.delete(sess_b)
    db_b.commit()
    db_b.close()

    # Session A: try to get active session (triggers expiry logic, but row already gone)
    result = get_active_session(db_a, sess_id)
    assert result is None

    # CRITICAL: verify Session A is still usable (no PendingRollbackError)
    from app.db.models import User
    users = db_a.scalars(select(User)).all()
    assert isinstance(users, list)

    db_a.close()
