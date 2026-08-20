"""Ordering and the favourite facet.

The SQL half of this module (search text, role facet) is exercised
end-to-end in test_library_routes.py, where a real query proves the
filter narrows a membership-scoped set. What is unit-tested here is the
ordering, which cannot live in SQL: "recent" and "pinned" come from a
per-user table the item query does not join.
"""

from datetime import datetime, timedelta, timezone

from app.library.search import LibraryQuery, keep_favorites, order_items

NOW = datetime(2026, 8, 20, 12, 0, tzinfo=timezone.utc)


class Item:
    """The two attributes ordering reads, and an id to assert on."""

    def __init__(self, id, name, updated_minutes_ago=0):
        self.id = id
        self.name = name
        self.updated_at = NOW - timedelta(minutes=updated_minutes_ago)


def test_the_defaults_change_nothing():
    params = LibraryQuery()
    assert params.q is None
    assert params.favorite is False
    assert params.role is None
    assert params.sort == "recent"


def test_recent_puts_what_you_opened_first():
    a, b, c = Item(1, "A"), Item(2, "B"), Item(3, "C")
    ordered = order_items(
        [a, b, c],
        LibraryQuery(sort="recent"),
        recents={3: NOW, 1: NOW - timedelta(hours=1)},
        favorites=set(),
    )
    assert [i.id for i in ordered] == [3, 1, 2]


def test_never_opened_items_fall_back_to_their_own_recency():
    # A fresh account has opened nothing; the list must still be useful.
    old, new = Item(1, "Old", updated_minutes_ago=60), Item(2, "New")
    ordered = order_items(
        [old, new], LibraryQuery(sort="recent"), recents={}, favorites=set()
    )
    assert [i.id for i in ordered] == [2, 1]


def test_pinned_items_float_above_everything():
    a, b = Item(1, "A"), Item(2, "B")
    ordered = order_items(
        [a, b], LibraryQuery(sort="recent"), recents={1: NOW}, favorites={2}
    )
    assert [i.id for i in ordered] == [2, 1]


def test_name_sort_ignores_case():
    ordered = order_items(
        [Item(1, "beta"), Item(2, "Alpha")],
        LibraryQuery(sort="name"),
        recents={},
        favorites=set(),
    )
    assert [i.id for i in ordered] == [2, 1]


def test_updated_sort_is_newest_first():
    ordered = order_items(
        [Item(1, "old", updated_minutes_ago=99), Item(2, "new")],
        LibraryQuery(sort="updated"),
        recents={},
        favorites=set(),
    )
    assert [i.id for i in ordered] == [2, 1]


def test_the_favourite_facet_keeps_only_pinned():
    items = [Item(1, "A"), Item(2, "B")]
    assert [i.id for i in keep_favorites(items, LibraryQuery(favorite=True), {2})] == [2]


def test_without_the_facet_nothing_is_dropped():
    items = [Item(1, "A"), Item(2, "B")]
    assert keep_favorites(items, LibraryQuery(), {2}) == items
