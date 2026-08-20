"""Favourites and recents: per user, and gone when the item is."""

import uuid

import pytest

from app.db.models import User, UserItemState
from app.library import state


def make_user(db, name="ALICE"):
    user = User(snowflake_account="ACME", snowflake_user=name)
    db.add(user)
    db.commit()
    return user


def test_favorite_toggles_and_is_idempotent(db):
    user = make_user(db)
    item = uuid.uuid4()
    state.set_favorite(db, user.id, "report", item, True)
    state.set_favorite(db, user.id, "report", item, True)
    assert state.favorite_ids(db, user.id, "report") == {item}
    # Toggling twice must not leave two rows to disagree with each other.
    assert db.query(UserItemState).count() == 1
    state.set_favorite(db, user.id, "report", item, False)
    assert state.favorite_ids(db, user.id, "report") == set()


def test_one_users_favorites_are_invisible_to_another(db):
    alice, bob = make_user(db), make_user(db, "BOB")
    item = uuid.uuid4()
    state.set_favorite(db, alice.id, "report", item, True)
    assert state.favorite_ids(db, bob.id, "report") == set()


def test_the_two_item_kinds_have_separate_namespaces(db):
    user = make_user(db)
    item = uuid.uuid4()
    state.set_favorite(db, user.id, "report", item, True)
    assert state.favorite_ids(db, user.id, "explore") == set()


def test_recording_a_view_moves_it_to_the_front(db):
    user = make_user(db)
    first, second = uuid.uuid4(), uuid.uuid4()
    state.record_view(db, user.id, "report", first)
    state.record_view(db, user.id, "report", second)
    state.record_view(db, user.id, "report", first)
    order = state.recent_order(db, user.id, "report")
    assert order[first] > order[second]


def test_viewing_does_not_clear_a_favorite(db):
    user = make_user(db)
    item = uuid.uuid4()
    state.set_favorite(db, user.id, "report", item, True)
    state.record_view(db, user.id, "report", item)
    assert state.favorite_ids(db, user.id, "report") == {item}


def test_an_item_never_opened_has_no_recency(db):
    user = make_user(db)
    item = uuid.uuid4()
    state.set_favorite(db, user.id, "report", item, True)
    assert state.recent_order(db, user.id, "report") == {}


def test_forgetting_an_item_removes_every_users_row(db):
    alice, bob = make_user(db), make_user(db, "BOB")
    item = uuid.uuid4()
    state.set_favorite(db, alice.id, "report", item, True)
    state.record_view(db, bob.id, "report", item)
    state.forget_item(db, "report", item)
    assert db.query(UserItemState).count() == 0


def test_an_unknown_item_type_is_refused(db):
    user = make_user(db)
    with pytest.raises(ValueError):
        state.set_favorite(db, user.id, "dashboard", uuid.uuid4(), True)
