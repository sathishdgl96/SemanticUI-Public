"""The browse filter.

The ordering used to be unit-tested here against two Python helpers,
because "recent" and "pinned" came from a per-user table the item query
did not join. They join now -- see `search.with_user_state` -- so the
database does the filtering and the ordering, and the behaviour is
exercised where it actually happens: end-to-end in test_scale.py, over a
real query against a real membership-scoped set.

What is left here is the shape of the request itself. Its defaults are
load-bearing: they are what an unfiltered listing sends.
"""

from app.library.search import MAX_ROWS, LibraryQuery


def test_the_defaults_change_nothing():
    """An unfiltered listing must send a request that narrows nothing --
    and the same one every time, or its query cache key moves on every
    re-render."""
    params = LibraryQuery()
    assert params.q is None
    assert params.favorite is False
    assert params.role is None
    assert params.sort == "recent"


def test_a_sort_nobody_defined_is_refused():
    """The value reaches an ORDER BY decision; it is not something a
    caller invents."""
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        LibraryQuery(sort="whatever")


def test_a_listing_is_bounded():
    """One workspace with thousands of reports must not be a slow page.
    The cap is asserted here so changing it is a deliberate act."""
    assert MAX_ROWS == 200
