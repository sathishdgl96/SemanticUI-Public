"""What Home shows: the last few things you opened.

Filtered by ACCESS, not merely by existence. A recent entry records that
this user once opened an item; whether they may still open it is a
question only the workspace gate can answer, and it is asked again on
every read.

The other half of Home -- the dashboard a user chose to open on -- lives
in `app/dashboards/service.py`, because it is a dashboard first and a
home page second.
"""

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Dashboard, Report, SavedExplore, Workspace
from app.errors import ApiError
from app.library import state
from app.workspaces.access import require_owned

#: Home leads with recents and then gives the rest of the page to a
#: dashboard. Five is what fits above the fold without pushing the
#: dashboard below it -- and the report list is one click away for the
#: rest.
RECENT_LIMIT = 5

_MODELS = {"report": Report, "explore": SavedExplore, "dashboard": Dashboard}


def _readable(db: Session, user_id: uuid.UUID, item_type: str, item_id) -> bool:
    """Whether this user may still open this item.

    Asked per item rather than by joining the membership table into the
    query: `require_owned` is the one place that decides, and a second
    expression of the same rule is where the two start to disagree.
    """
    try:
        require_owned(db, user_id, str(item_id), _MODELS[item_type], need="viewer")
        return True
    except ApiError:
        return False


def _name_of(row) -> str:
    # The column first: a dashboard is renamed through it, and a report's
    # document name is kept in step with it on every save.
    return getattr(row, "name", None) or (row.definition or {}).get("name") or "Untitled"


def recent_items(
    db: Session, user_id: uuid.UUID, limit: int = RECENT_LIMIT
) -> list[dict]:
    """The items this user opened most recently, newest first.

    Reports and explores are interleaved by time rather than listed in
    two sections: "what was I just working on" does not care which kind
    of thing the answer is.
    """
    seen: list[tuple[datetime, str, uuid.UUID]] = []
    for item_type in ("report", "explore", "dashboard"):
        for item_id, when in state.recent_order(db, user_id, item_type).items():
            seen.append((when, item_type, item_id))
    seen.sort(key=lambda entry: entry[0], reverse=True)

    out: list[dict] = []
    for when, item_type, item_id in seen:
        if len(out) >= limit:
            break
        row = db.get(_MODELS[item_type], item_id)
        # Gone, or no longer this user's to open. Skipped silently: a
        # recents list is a convenience, and explaining an absence here
        # would leak that the item exists.
        if row is None or not _readable(db, user_id, item_type, item_id):
            continue
        workspace = db.get(Workspace, row.workspace_id)
        out.append(
            {
                "itemType": item_type,
                "id": str(row.id),
                "name": _name_of(row),
                "workspaceName": workspace.name if workspace else "",
                "lastViewedAt": when.isoformat(),
            }
        )
    return out
