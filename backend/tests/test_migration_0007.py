"""0007 adds context and library state without disturbing what exists.

Every column it adds is nullable or defaulted, so a row written before
the migration stays readable after it. That is the property worth a
test: the feature is opt-in per row, and nobody's existing reports can
be hidden or altered by installing it.
"""

import uuid

from sqlalchemy import inspect

from app.db.models import Report, SavedExplore, User, UserItemState


def make_user(db, name="ALICE"):
    user = User(snowflake_account="ACME", snowflake_user=name)
    db.add(user)
    db.commit()
    return user


def test_a_user_starts_with_no_remembered_context(db):
    user = make_user(db)
    assert user.last_role is None
    assert user.last_warehouse is None


def test_remembered_context_round_trips(db):
    user = make_user(db)
    user.last_role = "ANALYST"
    user.last_warehouse = "COMPUTE_WH"
    db.commit()
    db.refresh(user)
    assert (user.last_role, user.last_warehouse) == ("ANALYST", "COMPUTE_WH")


def test_items_carry_a_nullable_context_stamp(db):
    for model in (Report, SavedExplore):
        columns = inspect(model).columns
        assert "snowflake_role" in columns
        assert "snowflake_warehouse" in columns
        assert columns["snowflake_role"].nullable
        assert columns["snowflake_warehouse"].nullable


def test_user_item_state_defaults_to_neither_pinned_nor_seen(db):
    user = make_user(db)
    db.add(UserItemState(user_id=user.id, item_type="report", item_id=uuid.uuid4()))
    db.commit()
    row = db.query(UserItemState).one()
    assert row.favorite is False
    assert row.last_viewed_at is None


def test_one_row_per_user_and_item(db):
    user = make_user(db)
    item = uuid.uuid4()
    db.add(UserItemState(user_id=user.id, item_type="report", item_id=item))
    db.commit()
    constraint_names = {c.name for c in inspect(UserItemState).tables[0].constraints}
    assert "uq_user_item_state" in constraint_names
