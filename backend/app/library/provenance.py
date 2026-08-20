"""The role and warehouse a saved item was last written under.

Provenance, never permission (ADR 0009): it drives the browse facet and
tells someone reopening a report which context it was built in. The
value comes from the user's current session context, which login keeps
truthful by reading it back off the connection.
"""

from typing import Any

from sqlalchemy.orm import Session

from app.db.models import User


def stamp(db: Session, user_id: Any, item: Any) -> None:
    """Record the writer's context on a report or explore.

    Both models carry the same two columns, so one function serves
    both. Silent when the context is unknown -- a NULL stamp simply
    means "no role facet", which is what an item saved before this
    existed also means.
    """
    user = db.get(User, user_id)
    if user is None:
        return
    item.snowflake_role = user.last_role
    item.snowflake_warehouse = user.last_warehouse


def creator_names(db: Session, owner_ids) -> dict:
    """{user id: Snowflake username} for a page of rows.

    One query for the whole list rather than one per row: a browse across
    every workspace can return hundreds, and "who made this" is not worth
    a round trip each.

    A missing user resolves to "" rather than being dropped, so a row
    whose creator has been deleted still lists -- who made it is a
    caption, not the reason the row exists.
    """
    keys = {owner for owner in owner_ids if owner is not None}
    if not keys:
        return {}
    from sqlalchemy import select

    rows = db.execute(
        select(User.id, User.snowflake_user).where(User.id.in_(keys))
    ).all()
    return {user_id: name for user_id, name in rows}
