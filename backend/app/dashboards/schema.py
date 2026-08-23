"""The dashboard definition document.

Deliberately thin. A dashboard owns no visuals -- every tile NAMES one
that lives on a report -- so there is nothing here to validate against the
visual catalog, no wells to check and no semantic view to bind. What a
tile is allowed to say is: which report, which page, which visual, where
on the canvas, and optionally what to call it here.

Everything else about a tile is resolved from the report at read time, and
that is the point: the report stays the single definition of what the
visual is.
"""

import json

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.errors import ApiError, safe_error_details

SCHEMA_VERSION = 1
#: A dashboard is a wall you look at, not a report you page through. Past
#: about this many tiles nobody is reading it -- and every tile is a live
#: query against Snowflake on the reader's own connection.
MAX_TILES = 40
MAX_DEFINITION_BYTES = 65536
#: Ids inside a report document, which the report schema bounds at 64.
MAX_ID = 64


class _Strict(BaseModel):
    # `extra="forbid"`, EXCEPT that a document written before
    # announcements moved out of the dashboard still carries the key. It
    # is ignored rather than refused: a saved dashboard must not become
    # unopenable because a field moved somewhere better.
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class TileLayout(_Strict):
    x: int = Field(ge=0, le=11)
    y: int = Field(ge=0, le=999)
    w: int = Field(ge=1, le=12)
    h: int = Field(ge=1, le=100)


class Tile(_Strict):
    #: The tile's own id, unique within this dashboard. The same visual may
    #: legitimately appear twice -- beside a different one, at a different
    #: size -- so the report/page/visual triple is not the key.
    id: str = Field(max_length=MAX_ID)
    reportId: str = Field(max_length=64)
    pageId: str = Field(max_length=MAX_ID)
    visualId: str = Field(max_length=MAX_ID)
    #: What to call it HERE. Null means whatever the visual is called on
    #: its report, which is usually right and always current.
    title: str | None = Field(default=None, max_length=200)
    layout: TileLayout


class DashboardDefinition(_Strict):
    schemaVersion: int = SCHEMA_VERSION
    name: str = Field(max_length=200)
    tiles: list[Tile] = Field(default_factory=list, max_length=MAX_TILES)


def parse_definition(raw: dict) -> DashboardDefinition:
    """Validate a document, or raise the error the client should see.

    Size is checked first and on the RAW document: a payload large enough
    to be a problem is a problem before it is parsed, not after.
    """
    # Announcements moved out of the dashboard and into their own object.
    # A document saved before that still carries the key, and refusing it
    # would make a saved dashboard unopenable because a field moved.
    raw = {key: value for key, value in raw.items() if key != "announcement"}
    encoded = json.dumps(raw, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_DEFINITION_BYTES:
        raise ApiError(
            "DASHBOARD_TOO_LARGE",
            413,
            "This dashboard is too large to save.",
        )
    try:
        definition = DashboardDefinition.model_validate(raw)
    except ValidationError as error:
        raise ApiError(
            "DASHBOARD_INVALID",
            400,
            "This dashboard document is not valid.",
            # `.errors()`, not the exception: safe_error_details takes the
            # list of error dicts and strips the caller's own input value
            # out of each -- serialising the exception would echo the
            # submitted document straight back in the response body.
            str(safe_error_details(error.errors())),
        ) from error

    seen = set()
    for tile in definition.tiles:
        if tile.id in seen:
            # Two tiles with one id makes "remove this tile" ambiguous, and
            # the grid library keys on it.
            raise ApiError(
                "DASHBOARD_INVALID", 400, "Two tiles on this dashboard share an id."
            )
        seen.add(tile.id)
    return definition


def blank(name: str) -> dict:
    return {"schemaVersion": SCHEMA_VERSION, "name": name, "tiles": []}
