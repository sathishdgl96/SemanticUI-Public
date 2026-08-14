import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy.exc import IntegrityError

from app.db.models import DbSession, User


def test_user_identity_is_unique(db):
    db.add(User(snowflake_account="ACME", snowflake_user="ALICE"))
    db.commit()
    db.add(User(snowflake_account="ACME", snowflake_user="ALICE"))
    with pytest.raises(IntegrityError):
        db.commit()


def test_session_links_to_user(db):
    user = User(snowflake_account="ACME", snowflake_user="ALICE")
    db.add(user)
    db.commit()
    sess = DbSession(
        id="sid-1",
        user_id=user.id,
        mode="dev",
        last_seen_at=datetime.now(timezone.utc),
    )
    db.add(sess)
    db.commit()
    loaded = db.get(DbSession, "sid-1")
    assert loaded.user.snowflake_user == "ALICE"
    assert loaded.access_token_enc is None
    assert isinstance(loaded.user.id, uuid.UUID)
