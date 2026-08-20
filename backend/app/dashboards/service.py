"""Dashboards, and the tiles on them.

Two rules carry the whole design.

**A tile names a visual; it does not copy one.** The report document stays
the single definition of what the visual is, so a tile follows edits to
it, and resolving a tile runs through the same authorization gate as
opening the report. A tile whose report is gone, whose page was removed or
whose visual was taken off the canvas is not an error -- it is a tile with
nothing behind it, and it says so.

**A tile may not leave the workspace.** Pinning is refused unless the
report lives in the dashboard's own workspace. Without that rule a
dashboard could show a report half its members cannot open, and every one
of them would see a different dashboard.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.dashboards.schema import MAX_TILES, blank, parse_definition
from app.db.models import Dashboard, Report, User, Workspace
from app.errors import ApiError
from app.library import provenance, state
from app.reports.migrate import migrate_definition
from app.reports.service import personal_workspace_id
from app.workspaces.access import as_uuid, membership, require_owned, require_workspace

#: Dashboard tiles are wider than a report's because a dashboard is read at
#: arm's length rather than authored.
DEFAULT_TILE = {"w": 4, "h": 5}


def _summary(
    dashboard: Dashboard, *, workspace: Workspace | None, role: str, creator: str = ""
) -> dict:
    definition = dashboard.definition or {}
    return {
        "id": str(dashboard.id),
        "name": dashboard.name,
        "workspaceId": str(dashboard.workspace_id),
        "workspaceName": workspace.name if workspace else "",
        "myRole": role,
        "announcement": definition.get("announcement") or None,
        "tileCount": len(definition.get("tiles") or []),
        "updatedAt": dashboard.updated_at.isoformat() if dashboard.updated_at else None,
        #: Who made it. Provenance, never permission (ADR 0009).
        "createdBy": creator,
    }


def _context(db: Session, user_id, dashboard: Dashboard) -> tuple[Workspace | None, str]:
    workspace = db.get(Workspace, dashboard.workspace_id)
    member = membership(db, user_id, dashboard.workspace_id)
    return workspace, member.role if member else ""


def list_dashboards(db: Session, user_id: uuid.UUID, workspace_id: str | None) -> list[dict]:
    """Every dashboard this user can see, optionally in one workspace.

    Scoped by JOINing membership rather than by listing then filtering:
    a row a caller may not read must never leave the database.
    """
    from app.db.models import WorkspaceMember

    query = (
        select(Dashboard)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Dashboard.workspace_id)
        .where(WorkspaceMember.user_id == user_id)
    )
    if workspace_id:
        key = as_uuid(workspace_id)
        if key is None:
            return []
        query = query.where(Dashboard.workspace_id == key)
    rows = db.scalars(query.order_by(Dashboard.updated_at.desc())).all()
    # Pins and recents work the same on a dashboard as on anything else,
    # so one browse list can hold all three kinds and sort them together.
    favorites = state.favorite_ids(db, user_id, "dashboard")
    recents = state.recent_order(db, user_id, "dashboard")
    creators = provenance.creator_names(db, [row.owner_user_id for row in rows])
    out = []
    for row in rows:
        workspace, role = _context(db, user_id, row)
        summary = _summary(
            row, workspace=workspace, role=role, creator=creators.get(row.owner_user_id, "")
        )
        summary["favorite"] = row.id in favorites
        seen = recents.get(row.id)
        summary["lastViewedAt"] = seen.isoformat() if seen else None
        out.append(summary)
    return out


def create_dashboard(
    db: Session, user_id: uuid.UUID, name: str, workspace_id: str | None
) -> Dashboard:
    # The named workspace, or mine -- the same rule new reports follow.
    target = (
        require_workspace(db, user_id, workspace_id, need="editor").id
        if workspace_id
        else personal_workspace_id(db, user_id)
    )
    clean = (name or "").strip()[:200] or "Untitled dashboard"
    dashboard = Dashboard(
        owner_user_id=user_id,
        workspace_id=target,
        name=clean,
        definition=blank(clean),
    )
    db.add(dashboard)
    db.commit()
    db.refresh(dashboard)
    return dashboard


def get_dashboard(db: Session, user_id: uuid.UUID, dashboard_id: str) -> Dashboard:
    return require_owned(db, user_id, dashboard_id, Dashboard, need="viewer")


def update_dashboard(
    db: Session, user_id: uuid.UUID, dashboard_id: str, definition: dict
) -> Dashboard:
    dashboard = require_owned(db, user_id, dashboard_id, Dashboard, need="editor")
    parsed = parse_definition(definition)
    # Every tile is re-checked, not only the ones that changed: an update
    # is the one place a client could introduce a tile naming a report in
    # another workspace.
    for tile in parsed.tiles:
        _report_in_workspace(db, user_id, dashboard, tile.reportId)
    dashboard.definition = parsed.model_dump()
    dashboard.name = parsed.name
    db.commit()
    db.refresh(dashboard)
    return dashboard


def delete_dashboard(db: Session, user_id: uuid.UUID, dashboard_id: str) -> None:
    dashboard = require_owned(db, user_id, dashboard_id, Dashboard, need="editor")
    # Anyone who chose it for their home now has no dashboard chosen. A
    # dangling pointer would resolve to "no longer available" on every
    # visit, forever.
    db.query(User).filter(User.home_dashboard_id == dashboard.id).update(
        {"home_dashboard_id": None}
    )
    db.delete(dashboard)
    db.commit()


def _report_in_workspace(
    db: Session, user_id: uuid.UUID, dashboard: Dashboard, report_id: str
) -> Report:
    """The report a tile names, or the reason it cannot be pinned here."""
    report = require_owned(db, user_id, report_id, Report, need="viewer")
    if report.workspace_id != dashboard.workspace_id:
        raise ApiError(
            "REPORT_OUTSIDE_WORKSPACE",
            400,
            "A dashboard can only show reports from its own workspace.",
        )
    return report


def _find_visual(definition: dict, page_id: str, visual_id: str):
    for page in definition.get("pages") or []:
        if page.get("id") != page_id:
            continue
        for visual in page.get("visuals") or []:
            if visual.get("id") == visual_id:
                return page, visual
    return None, None


def _next_row(tiles: list[dict]) -> int:
    """Below everything already placed, so a new tile never lands on one
    somebody positioned."""
    return max(
        (
            (tile.get("layout") or {}).get("y", 0) + (tile.get("layout") or {}).get("h", 0)
            for tile in tiles
        ),
        default=0,
    )


def add_tile(
    db: Session,
    user_id: uuid.UUID,
    dashboard_id: str,
    report_id: str,
    page_id: str,
    visual_id: str,
    title: str | None = None,
) -> dict:
    """Pin a visual onto a dashboard.

    Editor on the dashboard's workspace, and viewer on the report -- which
    inside one workspace is the same membership, but stated separately
    because the two are different questions.
    """
    dashboard = require_owned(db, user_id, dashboard_id, Dashboard, need="editor")
    report = _report_in_workspace(db, user_id, dashboard, report_id)

    report_definition = migrate_definition(report.definition)
    _, visual = _find_visual(report_definition, page_id, visual_id)
    if visual is None:
        raise ApiError("VISUAL_NOT_FOUND", 404, "That visual is not on this report.")

    definition = dict(dashboard.definition or blank(dashboard.name))
    tiles = list(definition.get("tiles") or [])

    # Pinning the same visual twice is a click on a button already on. The
    # existing tile comes back, unmoved.
    for tile in tiles:
        if (
            tile.get("reportId") == str(report.id)
            and tile.get("pageId") == page_id
            and tile.get("visualId") == visual_id
        ):
            return resolve(db, user_id, dashboard, tile)

    if len(tiles) >= MAX_TILES:
        raise ApiError(
            "DASHBOARD_FULL",
            400,
            f"A dashboard holds at most {MAX_TILES} tiles.",
        )

    layout = visual.get("layout") or {}
    tile = {
        "id": uuid.uuid4().hex[:16],
        "reportId": str(report.id),
        "pageId": page_id,
        "visualId": visual_id,
        "title": (title or "").strip() or None,
        "layout": {
            "x": 0,
            "y": _next_row(tiles),
            # The size it had on its report, clamped: a tile that filled a
            # report page would fill the dashboard too.
            "w": max(2, min(int(layout.get("w") or DEFAULT_TILE["w"]), 6)),
            "h": max(2, min(int(layout.get("h") or DEFAULT_TILE["h"]), 10)),
        },
    }
    tiles.append(tile)
    definition["tiles"] = tiles
    definition.setdefault("schemaVersion", 1)
    definition.setdefault("announcement", None)
    definition["name"] = dashboard.name
    dashboard.definition = parse_definition(definition).model_dump()
    db.commit()
    db.refresh(dashboard)
    return resolve(db, user_id, dashboard, tile)


def remove_tile(db: Session, user_id: uuid.UUID, dashboard_id: str, tile_id: str) -> None:
    dashboard = require_owned(db, user_id, dashboard_id, Dashboard, need="editor")
    definition = dict(dashboard.definition or blank(dashboard.name))
    tiles = [tile for tile in (definition.get("tiles") or []) if tile.get("id") != tile_id]
    if len(tiles) == len(definition.get("tiles") or []):
        raise ApiError("HTTP_ERROR", 404, "Not found")
    definition["tiles"] = tiles
    dashboard.definition = definition
    db.commit()


def resolve(db: Session, user_id: uuid.UUID, dashboard: Dashboard, tile: dict) -> dict:
    """One tile, with everything needed to draw it -- or the reason not to."""
    base = {
        "id": tile.get("id"),
        "reportId": tile.get("reportId"),
        "pageId": tile.get("pageId"),
        "visualId": tile.get("visualId"),
        "title": tile.get("title"),
        "layout": tile.get("layout") or {"x": 0, "y": 0, **DEFAULT_TILE},
    }

    key = as_uuid(tile.get("reportId") or "")
    report = db.get(Report, key) if key else None
    readable = False
    if report is not None:
        try:
            require_owned(db, user_id, str(report.id), Report, need="viewer")
            readable = True
        except ApiError:
            readable = False
    if report is None or not readable:
        # One answer for both. Distinguishing "deleted" from "not yours"
        # would tell a former member that a report still exists.
        return {**base, "available": False, "reason": "This report is no longer available."}

    definition = migrate_definition(report.definition)
    page, visual = _find_visual(definition, tile.get("pageId"), tile.get("visualId"))
    if visual is None:
        return {
            **base,
            "available": False,
            "reason": "This visual is no longer on the report.",
            "reportName": definition.get("name") or "Untitled",
        }

    return {
        **base,
        "available": True,
        "reportName": definition.get("name") or "Untitled",
        "view": definition.get("view") or {},
        "visual": visual,
        # The report's own scopes travel with the visual, or a tile would
        # show a different number from the report it came from -- the one
        # thing a dashboard must never do.
        "reportFilters": definition.get("filters") or [],
        "pageFilters": page.get("filters") or [],
        "hierarchies": definition.get("hierarchies") or [],
    }


def detail(db: Session, user_id: uuid.UUID, dashboard: Dashboard) -> dict:
    workspace, role = _context(db, user_id, dashboard)
    definition = dashboard.definition or {}
    creators = provenance.creator_names(db, [dashboard.owner_user_id])
    return {
        **_summary(
            dashboard,
            workspace=workspace,
            role=role,
            creator=creators.get(dashboard.owner_user_id, ""),
        ),
        "tiles": [
            resolve(db, user_id, dashboard, tile)
            for tile in (definition.get("tiles") or [])
        ],
    }


# --- which dashboard opens on Home -----------------------------------------


def set_home_dashboard(
    db: Session, user_id: uuid.UUID, dashboard_id: str | None
) -> None:
    """Choose (or clear) the dashboard this user opens on Home.

    Checked before it is stored: setting a dashboard you cannot read would
    store a pointer that resolves to nothing on every visit.
    """
    user = db.get(User, user_id)
    if user is None:
        raise ApiError("HTTP_ERROR", 404, "Not found")
    if dashboard_id is None:
        user.home_dashboard_id = None
    else:
        dashboard = require_owned(db, user_id, dashboard_id, Dashboard, need="viewer")
        user.home_dashboard_id = dashboard.id
    db.commit()


def home_dashboard(db: Session, user_id: uuid.UUID) -> dict | None:
    """The chosen dashboard, resolved -- or None.

    None covers every way a choice can stop being valid: never made, the
    dashboard deleted, the workspace left. All three mean the same thing to
    the page, which offers to choose one.
    """
    user = db.get(User, user_id)
    if user is None or user.home_dashboard_id is None:
        return None
    dashboard = db.get(Dashboard, user.home_dashboard_id)
    if dashboard is None:
        return None
    try:
        require_owned(db, user_id, str(dashboard.id), Dashboard, need="viewer")
    except ApiError:
        return None
    return detail(db, user_id, dashboard)
