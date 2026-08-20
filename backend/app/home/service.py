"""Recents and pinned widgets, resolved.

Two things happen here that are worth stating plainly.

First, both lists are filtered by ACCESS, not merely by existence. A
recent entry is a row this user once opened; whether they may still open
it is a question only the workspace gate can answer, and it is asked
again on every read. The same goes for a widget: it names a report, and
naming one is not the same as being allowed to see it.

Second, a widget is resolved rather than stored. The report document is
the definition of what the visual is; the widget only says which one. So
a widget whose report has been deleted, whose page has been removed, or
whose visual was taken off the canvas is not an error -- it is a widget
with nothing behind it any more, and it comes back marked as such so the
page can say so and offer to remove it.
"""

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import HomeWidget, Report, SavedExplore, Workspace
from app.errors import ApiError
from app.library import state
from app.reports.migrate import migrate_definition
from app.workspaces.access import membership, require_owned

#: What the home page shows without being asked. Ten is the number a
#: person actually returns to; a longer list is a search box wearing a
#: different hat.
RECENT_LIMIT = 10

_MODELS = {"report": Report, "explore": SavedExplore}


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
    definition = row.definition or {}
    return definition.get("name") or "Untitled"


def recent_items(
    db: Session, user_id: uuid.UUID, limit: int = RECENT_LIMIT
) -> list[dict]:
    """The items this user opened most recently, newest first.

    Reports and explores are interleaved by time rather than listed in
    two sections: "what was I just working on" does not care which kind
    of thing the answer is.
    """
    seen: list[tuple[datetime, str, uuid.UUID]] = []
    for item_type in ("report", "explore"):
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


def _find_visual(definition: dict, page_id: str, visual_id: str):
    for page in definition.get("pages") or []:
        if page.get("id") != page_id:
            continue
        for visual in page.get("visuals") or []:
            if visual.get("id") == visual_id:
                return page, visual
    return None, None


def _resolved(db: Session, user_id: uuid.UUID, widget: HomeWidget) -> dict:
    """One widget, with everything needed to draw it -- or the reason not to.

    The whole report travels through `migrate_definition` first, exactly
    as opening the report would, so a widget never renders a document
    shape the report screen would have upgraded.
    """
    base = {
        "id": str(widget.id),
        "reportId": str(widget.report_id),
        "pageId": widget.page_id,
        "visualId": widget.visual_id,
        "layout": {"x": widget.x, "y": widget.y, "w": widget.w, "h": widget.h},
        "title": widget.title,
    }

    report = db.get(Report, widget.report_id)
    if report is None or not _readable(db, user_id, "report", widget.report_id):
        # Deliberately the same answer for both. Distinguishing "deleted"
        # from "not yours any more" would tell a former member that a
        # report they can no longer read still exists.
        return {**base, "available": False, "reason": "This report is no longer available."}

    definition = migrate_definition(report.definition)
    page, visual = _find_visual(definition, widget.page_id, widget.visual_id)
    if visual is None:
        return {
            **base,
            "available": False,
            "reason": "This visual is no longer on the report.",
            "reportName": definition.get("name") or "Untitled",
        }

    workspace = db.get(Workspace, report.workspace_id)
    member = membership(db, user_id, report.workspace_id)
    return {
        **base,
        "available": True,
        "reportName": definition.get("name") or "Untitled",
        "workspaceName": workspace.name if workspace else "",
        "myRole": member.role if member else "",
        "view": definition.get("view") or {},
        "visual": visual,
        # The report's own scopes travel with the visual, or the widget
        # would show a different number from the report it came from --
        # which is the one thing a pinned tile must never do.
        "reportFilters": definition.get("filters") or [],
        "pageFilters": page.get("filters") or [],
        "hierarchies": definition.get("hierarchies") or [],
    }


def list_widgets(db: Session, user_id: uuid.UUID) -> list[dict]:
    widgets = db.scalars(
        select(HomeWidget)
        .where(HomeWidget.user_id == user_id)
        # Reading order, so a grid restored from these rows lands the way
        # it was left rather than the way the ids sorted.
        .order_by(HomeWidget.y, HomeWidget.x, HomeWidget.created_at)
    ).all()
    return [_resolved(db, user_id, widget) for widget in widgets]


def _next_row(db: Session, user_id: uuid.UUID) -> int:
    """Below everything already there. A new widget lands at the bottom
    rather than on top of one the user placed."""
    rows = db.scalars(
        select(HomeWidget).where(HomeWidget.user_id == user_id)
    ).all()
    return max((widget.y + widget.h for widget in rows), default=0)


def pin(
    db: Session,
    user_id: uuid.UUID,
    report_id: str,
    page_id: str,
    visual_id: str,
    title: str | None = None,
) -> dict:
    """Pin a visual, after checking the caller may read the report it is in.

    Pinning something twice is not an error -- it is a click on a button
    that is already on. The existing widget comes back unmoved.
    """
    report = require_owned(db, user_id, report_id, Report, need="viewer")
    definition = migrate_definition(report.definition)
    _, visual = _find_visual(definition, page_id, visual_id)
    if visual is None:
        raise ApiError(
            "VISUAL_NOT_FOUND", 404, "That visual is not on this report."
        )

    existing = db.scalar(
        select(HomeWidget).where(
            HomeWidget.user_id == user_id,
            HomeWidget.report_id == report.id,
            HomeWidget.page_id == page_id,
            HomeWidget.visual_id == visual_id,
        )
    )
    if existing is not None:
        return _resolved(db, user_id, existing)

    layout = visual.get("layout") or {}
    widget = HomeWidget(
        user_id=user_id,
        report_id=report.id,
        page_id=page_id,
        visual_id=visual_id,
        title=(title or "").strip() or None,
        x=0,
        y=_next_row(db, user_id),
        # The size it had on the report, clamped: a tile that filled a
        # 12-column canvas would fill the home page too, and a home page
        # is a summary.
        w=max(2, min(int(layout.get("w") or 4), 6)),
        h=max(2, min(int(layout.get("h") or 4), 8)),
    )
    db.add(widget)
    db.commit()
    return _resolved(db, user_id, widget)


def unpin(db: Session, user_id: uuid.UUID, widget_id: str) -> None:
    """Remove one of this user's widgets.

    Scoped by user_id in the WHERE clause rather than fetched and then
    checked: there is no path here that can act on someone else's row.
    An id that is not theirs is simply not found.
    """
    widget = db.scalar(
        select(HomeWidget).where(
            HomeWidget.id == _as_uuid(widget_id),
            HomeWidget.user_id == user_id,
        )
    )
    if widget is None:
        raise ApiError("HTTP_ERROR", 404, "Not found")
    db.delete(widget)
    db.commit()


def rearrange(db: Session, user_id: uuid.UUID, layouts: list[dict]) -> None:
    """Write back a moved or resized grid.

    Ids not belonging to this user are ignored rather than rejected: the
    grid library sends the whole layout, and one stale entry in it must
    not fail the whole save.
    """
    mine = {
        widget.id: widget
        for widget in db.scalars(
            select(HomeWidget).where(HomeWidget.user_id == user_id)
        )
    }
    for entry in layouts:
        widget = mine.get(_as_uuid(entry.get("id")))
        if widget is None:
            continue
        widget.x = max(0, int(entry.get("x", widget.x)))
        widget.y = max(0, int(entry.get("y", widget.y)))
        widget.w = max(1, int(entry.get("w", widget.w)))
        widget.h = max(1, int(entry.get("h", widget.h)))
    db.commit()


def forget_report(db: Session, report_id) -> None:
    """Drop every user's widgets for a report being deleted.

    Called from the delete path for the same reason `forget_item` is: the
    reference carries no foreign key, so nothing else will.
    """
    db.query(HomeWidget).filter(HomeWidget.report_id == report_id).delete()
    db.commit()


def _as_uuid(value) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None
