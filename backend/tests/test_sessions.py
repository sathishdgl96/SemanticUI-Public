from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.auth.crypto import decrypt_token
from app.auth.sessions import (
    create_session,
    delete_session,
    get_active_session,
    new_session_id,
)
from app.db.models import User


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


def test_delete_session(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    delete_session(db, sess.id)
    assert get_active_session(db, sess.id) is None
