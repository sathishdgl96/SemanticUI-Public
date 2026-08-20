"""One browse filter, applied identically to reports and explores.

Both lists browse the same way, so the query lives here rather than
twice in two services that would drift. Everything here NARROWS: it is
applied after the membership join, so a facet can hide something the
caller may already see and can never reveal something they may not.

The role facet is provenance, not permission (ADR 0009). It is shown to
the user as a chip they can dismiss, which is the whole reason it is
safe: a filter nobody can see is indistinguishable from missing data.
"""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel
from sqlalchemy import func, or_

from app.db.models import Workspace


class LibraryQuery(BaseModel):
    """What the browse controls asked for."""

    #: Free text over name, semantic view and workspace name.
    q: str | None = None
    #: Pinned only. Lives outside SQL because pins are per user.
    favorite: bool = False
    #: The provenance facet: items last saved under this Snowflake role.
    role: str | None = None
    sort: Literal["recent", "name", "updated"] = "recent"


def apply(query: Any, model: Any, params: LibraryQuery) -> Any:
    """Narrow a select of `model` (Report or SavedExplore).

    `model` is passed rather than imported so the one implementation
    serves both tables; they carry the same four columns this touches.
    """
    if params.q and params.q.strip():
        # LIKE pattern or not, the value is BOUND -- it reaches the
        # driver as a parameter and never as SQL text.
        pattern = f"%{params.q.strip().lower()}%"
        query = query.join(Workspace, Workspace.id == model.workspace_id).where(
            or_(
                func.lower(model.name).like(pattern),
                func.lower(model.view_name).like(pattern),
                func.lower(Workspace.name).like(pattern),
            )
        )
    if params.role:
        query = query.where(func.upper(model.snowflake_role) == params.role.upper())
    return query


def keep_favorites(items: list, params: LibraryQuery, favorites: set) -> list:
    """The pinned-only facet, which SQL cannot express here: pins live
    in a per-user table the item query does not join."""
    if not params.favorite:
        return items
    return [item for item in items if item.id in favorites]


def _stamp(value: Any) -> float:
    """Seconds, for ordering. Tolerates None and plain numbers so the
    ordering can be reasoned about without constructing timestamps."""
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, datetime):
        return value.timestamp()
    return 0.0


def order_items(
    items: list, params: LibraryQuery, recents: dict, favorites: set
) -> list:
    """Sort in Python: "recent" and "pinned" come from a per-user table
    the item query does not join, so the database cannot order by them."""
    if params.sort == "name":
        return sorted(items, key=lambda item: item.name.lower())
    if params.sort == "updated":
        return sorted(items, key=lambda item: _stamp(item.updated_at), reverse=True)

    def key(item: Any) -> tuple:
        seen = recents.get(item.id)
        return (
            0 if item.id in favorites else 1,   # pinned first
            0 if seen else 1,                   # then what you have opened
            -_stamp(seen),                      # most recently opened first
            -_stamp(item.updated_at),           # the rest by their own recency
        )

    return sorted(items, key=key)
