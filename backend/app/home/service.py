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
from app.library import state
from app.workspaces.access import roles_for, workspaces_by_id

#: Home leads with recents and then gives the rest of the page to a
#: dashboard. Five is what fits above the fold without pushing the
#: dashboard below it -- and the report list is one click away for the
#: rest.
RECENT_LIMIT = 5

_MODELS = {"report": Report, "explore": SavedExplore, "dashboard": Dashboard}


def _readable(row, roles: dict) -> bool:
    """Whether this user may still open this item.

    A PROBE, not a decision. `require_owned` is what decides whether
    somebody may act, and it records a refusal -- so asking it here wrote
    an audit denial, and committed it, for every recent item whose
    workspace the reader had since left, on every single page load. It
    also cost two queries per item to draw a list of five.

    The rule itself is unchanged: membership of the owning workspace, and
    nothing else. `roles_for` reads the same table in one query.
    """
    return row is not None and row.workspace_id in roles


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

    roles = roles_for(db, user_id)
    spaces = workspaces_by_id(db, roles)

    out: list[dict] = []
    for when, item_type, item_id in seen:
        if len(out) >= limit:
            break
        row = db.get(_MODELS[item_type], item_id)
        # Gone, or no longer this user's to open. Skipped silently: a
        # recents list is a convenience, and explaining an absence here
        # would leak that the item exists.
        if not _readable(row, roles):
            continue
        workspace = spaces.get(row.workspace_id)
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
