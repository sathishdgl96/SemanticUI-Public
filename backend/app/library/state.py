"""What a user has pinned, and what they last opened.

Recents cost the user nothing -- they are a side effect of opening an
item -- and cover the case that actually matters at scale: of a hundred
saved items a person returns to about ten. Favourites cover the rest,
explicitly. Both live on one row because both answer the same question:
what is this person's relationship to this item.

Nothing here is an access check. Callers resolve the item through its
own authorization gate first; these functions assume that already
happened and only record the answer.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import UserItemState

#: The item kinds that can be pinned or viewed. Guarded rather than
#: free-form so a typo cannot quietly create a parallel namespace that
#: silently returns nothing.
ITEM_TYPES = ("report", "explore", "dashboard")


def _check(item_type: str) -> str:
    if item_type not in ITEM_TYPES:
        raise ValueError(f"unknown item type {item_type!r}")
    return item_type


def _row(db: Session, user_id, item_type: str, item_id) -> UserItemState:
    """This user's row for this item, created on first use."""
    row = db.scalar(
        select(UserItemState).where(
            UserItemState.user_id == user_id,
            UserItemState.item_type == _check(item_type),
            UserItemState.item_id == item_id,
        )
    )
    if row is None:
        row = UserItemState(user_id=user_id, item_type=item_type, item_id=item_id)
        db.add(row)
    return row


def set_favorite(db: Session, user_id, item_type: str, item_id, favorite: bool) -> None:
    _row(db, user_id, item_type, item_id).favorite = favorite
    db.commit()


def record_view(db: Session, user_id, item_type: str, item_id) -> None:
    _row(db, user_id, item_type, item_id).last_viewed_at = datetime.now(timezone.utc)
    db.commit()


def favorite_ids(db: Session, user_id, item_type: str) -> set[uuid.UUID]:
    return set(
        db.scalars(
            select(UserItemState.item_id).where(
                UserItemState.user_id == user_id,
                UserItemState.item_type == _check(item_type),
                UserItemState.favorite.is_(True),
            )
        )
    )


def recent_order(db: Session, user_id, item_type: str) -> dict[uuid.UUID, datetime]:
    """{item id: when it was last opened}, omitting what never was."""
    rows = db.execute(
        select(UserItemState.item_id, UserItemState.last_viewed_at).where(
            UserItemState.user_id == user_id,
            UserItemState.item_type == _check(item_type),
            UserItemState.last_viewed_at.is_not(None),
        )
    ).all()
    return {item_id: seen for item_id, seen in rows}


def forget_item(db: Session, item_type: str, item_id) -> None:
    """Drop every user's state for an item being deleted.

    Called from the delete path rather than left to a foreign key: the
    reference is polymorphic, so the database cannot cascade it, and a
    pin outliving its report would resurface as a phantom row.
    """
    db.query(UserItemState).filter(
        UserItemState.item_type == _check(item_type),
        UserItemState.item_id == item_id,
    ).delete()
    db.commit()
