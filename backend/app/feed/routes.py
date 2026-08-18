r"""GET /api/feed/... -- the URLs Power Query refreshes.

    /api/feed/reports/{report}/visuals/{visual}.csv
    /api/feed/reports/{report}/visuals/{visual}.json

Auth is HTTP Basic carrying a connect token in the password field; the
username is ignored ("token" reads well in the Excel prompt). The token
resolves to the caller's signed-in app session and its cached Snowflake
connection. Under /api deliberately: the dev proxy and any production
reverse proxy already route that prefix, so the URL shown in the app works
verbatim in Excel.

Query parameters:
    f.TABLE.FIELD=value   adds an equality filter (repeatable, validated,
                          bound -- how a worksheet cell drives the slice)
    limit=N               row cap for this call

Truncation is reported in the X-Truncated header (and in the JSON body):
CSV has nowhere in-band to say it without corrupting the table.
"""

import base64
import binascii
import logging

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from app.auth import connect_token
from app.db.base import get_db
from app.errors import ApiError
from app.feed import service
from app.feed.render import to_csv, to_json
from app.snowflake.provider import get_cache

logger = logging.getLogger(__name__)

router = APIRouter()


def _unauthorized() -> Response:
    from app.config import get_settings

    return Response(
        status_code=401,
        headers={
            "WWW-Authenticate": f'Basic realm="{get_settings().app_name} feed"'
        },
        content=(
            "Connect token required: any username, the token from the "
            "report's Connect panel as the password."
        ),
    )


def _app_session(request: Request, db: Session):
    """The app session the Basic-auth connect token resolves to, or None."""
    header = request.headers.get("Authorization", "")
    if not header.startswith("Basic "):
        return None
    try:
        decoded = base64.b64decode(header[6:]).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return None
    _, sep, password = decoded.partition(":")
    if not sep:
        return None
    return connect_token.resolve(db, password)


def _feed(
    request: Request,
    db: Session,
    report_id: str,
    visual_id: str,
    limit: int | None,
) -> tuple[list[str], list[list], bool]:
    dbsess = _app_session(request, db)
    if dbsess is None:
        raise ApiError("AUTH_REQUIRED", 401, "connect token required")
    entry = get_cache().acquire(db, dbsess)
    extra = {
        key[2:]: value
        for key, value in request.query_params.items()
        if key.startswith("f.") and len(key) > 2
    }
    return service.run_feed(
        db, dbsess.user_id, entry, report_id, visual_id,
        extra_filters=extra, limit=limit,
    )


@router.get("/api/feed/reports/{report_id}/visuals/{visual_id}.csv")
def feed_csv(
    report_id: str,
    visual_id: str,
    request: Request,
    limit: int | None = None,
    db: Session = Depends(get_db),
) -> Response:
    try:
        columns, rows, truncated = _feed(request, db, report_id, visual_id, limit)
    except ApiError as exc:
        if exc.status == 401:
            return _unauthorized()
        raise
    return Response(
        content=to_csv(columns, rows),
        media_type="text/csv; charset=utf-8",
        headers={"X-Truncated": "true" if truncated else "false"},
    )


@router.get("/api/feed/reports/{report_id}/visuals/{visual_id}.json")
def feed_json(
    report_id: str,
    visual_id: str,
    request: Request,
    limit: int | None = None,
    db: Session = Depends(get_db),
) -> Response:
    try:
        columns, rows, truncated = _feed(request, db, report_id, visual_id, limit)
    except ApiError as exc:
        if exc.status == 401:
            return _unauthorized()
        raise
    return Response(
        content=to_json(columns, rows, truncated),
        media_type="application/json",
        headers={"X-Truncated": "true" if truncated else "false"},
    )
