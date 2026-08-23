"""Timestamps are UTC-aware in Python, whichever database is underneath.

Postgres `timestamptz` hands back an aware datetime; SQLite hands back a
naive one, even for a column declared `DateTime(timezone=True)`. The same
code therefore serialized "2026-08-19T15:40:00" in development and
"2026-08-19T15:40:00+00:00" in production -- and a browser reads the first
as LOCAL time. In IST that moved every timestamp five and a half hours, so
something that had just happened read as "5 hours ago".

Worse than the display: it could not reproduce in production, which is the
kind of divergence that costs an afternoon.
"""

import uuid
from datetime import datetime, timedelta, timezone

from app.db.models import User


def test_a_stored_timestamp_comes_back_aware(db):
    user = User(
        id=uuid.uuid4(), snowflake_account="acct", snowflake_user="ada",
        welcomed_at=datetime(2026, 8, 19, 15, 40, tzinfo=timezone.utc),
    )
    db.add(user)
    db.commit()
    db.expire_all()

    read = db.get(User, user.id)
    assert read.welcomed_at.tzinfo is not None
    assert read.welcomed_at.utcoffset() == timedelta(0)


def test_the_serialized_form_carries_its_offset(db):
    # What actually reaches the browser. Without the offset a browser reads
    # the instant as local time, which is the whole bug.
    user = User(
        id=uuid.uuid4(), snowflake_account="acct", snowflake_user="bo",
        welcomed_at=datetime(2026, 8, 19, 15, 40, tzinfo=timezone.utc),
    )
    db.add(user)
    db.commit()
    db.expire_all()

    iso = db.get(User, user.id).welcomed_at.isoformat()
    assert iso.endswith("+00:00")


def test_an_aware_value_in_another_zone_is_stored_as_the_same_instant(db):
    # 21:10 IST is 15:40 UTC. Writing one and reading the other back must
    # not move the moment.
    ist = timezone(timedelta(hours=5, minutes=30))
    user = User(
        id=uuid.uuid4(), snowflake_account="acct", snowflake_user="cy",
        welcomed_at=datetime(2026, 8, 19, 21, 10, tzinfo=ist),
    )
    db.add(user)
    db.commit()
    db.expire_all()

    read = db.get(User, user.id).welcomed_at
    assert read == datetime(2026, 8, 19, 15, 40, tzinfo=timezone.utc)


def test_a_naive_value_written_by_older_code_is_read_as_utc(db):
    # Rows already in a development database were written naive. They were
    # always UTC in fact -- now_utc() produced them -- so they are read that
    # way rather than being left to mean whatever the reader's zone says.
    user = User(id=uuid.uuid4(), snowflake_account="acct", snowflake_user="di")
    db.add(user)
    db.commit()

    db.execute(
        User.__table__.update()
        .where(User.id == user.id)
        .values(welcomed_at=datetime(2026, 8, 19, 15, 40)),
    )
    db.commit()
    db.expire_all()

    read = db.get(User, user.id).welcomed_at
    assert read == datetime(2026, 8, 19, 15, 40, tzinfo=timezone.utc)
