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
