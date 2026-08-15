"""The portable report definition document.

This is exactly what `GET /api/reports/{id}/export` emits and what
`POST /api/reports/import` accepts, so it is parsed defensively: unknown keys
are refused rather than dropped, every visual is checked against the catalog,
and the whole thing is size-bounded.
"""

import json
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.errors import ApiError, safe_error_details
from app.reports.catalog import CATALOG, validate_wells

SCHEMA_VERSION = 1
MAX_VISUALS = 50
MAX_DEFINITION_BYTES = 65536

# A well reference is "TABLE.FIELD"; each part is a Snowflake identifier,
# which tops out at 255 characters, so 255 + "." + 255 = 511 is the longest
# a legitimate reference can ever be.
MAX_REF_LENGTH = 511
# No real visual places more than a few dozen fields in one well (the
# widest catalog well -- Values/metrics -- is naturally small in practice);
# 50 is a generous ceiling that also matches MAX_VISUALS below.
MAX_REFS_PER_WELL = 50

WellRef = Annotated[str, Field(max_length=MAX_REF_LENGTH)]
WellRefs = Annotated[list[WellRef], Field(max_length=MAX_REFS_PER_WELL)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ViewRef(_Strict):
    # Empty strings are allowed: a brand-new report is not bound to a
    # semantic view yet. `parse_definition` enforces the real invariant --
    # a report may be unbound only while it holds no visuals -- below, once
    # pydantic's structural checks have passed.
    database: str = Field(max_length=255)
    schema_: str = Field(alias="schema", max_length=255)
    name: str = Field(max_length=255)


class VisualLayout(_Strict):
    x: int = Field(ge=0, le=11)
    y: int = Field(ge=0, le=999)
    w: int = Field(ge=1, le=12)
    h: int = Field(ge=1, le=100)


class Visual(_Strict):
    id: str = Field(min_length=1, max_length=64)
    type: str
    title: str = Field(default="", max_length=200)
    layout: VisualLayout
    wells: dict[str, WellRefs] = Field(default_factory=dict)
    options: dict[str, object] = Field(default_factory=dict)


class CanvasSettings(_Strict):
    columns: int = Field(default=12, ge=1, le=24)
    rowHeight: int = Field(default=40, ge=10, le=200)


class ReportDefinition(_Strict):
    schemaVersion: int
    name: str = Field(min_length=1, max_length=200)
    view: ViewRef
    canvas: CanvasSettings = Field(default_factory=CanvasSettings)
    visuals: list[Visual] = Field(default_factory=list)


def _invalid(message: str, detail: str | None = None) -> ApiError:
    return ApiError("REPORT_INVALID", 400, message, detail=detail)


def parse_definition(raw: dict) -> ReportDefinition:
    """Validate an untrusted definition document. Raises ApiError on any problem."""
    if not isinstance(raw, dict):
        raise _invalid("A report definition must be a JSON object")

    # Every write path (create, update, import) funnels through here, so this
    # is the one place that bounds what a definition can weigh before any
    # more expensive validation (or a database write) happens.
    if len(json.dumps(raw)) > MAX_DEFINITION_BYTES:
        raise _invalid(f"The definition exceeds the {MAX_DEFINITION_BYTES} byte limit")

    version = raw.get("schemaVersion")
    if version != SCHEMA_VERSION:
        raise _invalid(
            f"Unsupported schemaVersion {version!r}; this build reads version "
            f"{SCHEMA_VERSION}"
        )

    visuals = raw.get("visuals")
    if isinstance(visuals, list) and len(visuals) > MAX_VISUALS:
        raise _invalid(f"A report may hold at most {MAX_VISUALS} visuals")

    try:
        definition = ReportDefinition.model_validate(raw)
    except ValidationError as exc:
        # Pydantic's own text names the offending path, which is what the user
        # needs. Strip the raw `input` value first -- it would otherwise echo
        # whatever the caller submitted (including anything sensitive) back
        # into the response body.
        raise _invalid(
            "The report definition is not valid",
            detail=str(safe_error_details(exc.errors())),
        )

    view = definition.view
    is_unbound = not view.database or not view.schema_ or not view.name
    if is_unbound and definition.visuals:
        raise _invalid(
            "This report must be bound to a semantic view before it can hold "
            "visuals. Pick a semantic view first, or remove its visuals."
        )

    seen_ids: set[str] = set()
    for visual in definition.visuals:
        if visual.id in seen_ids:
            raise _invalid(f"Duplicate visual id {visual.id!r}")
        seen_ids.add(visual.id)

        spec = CATALOG.get(visual.type)
        if spec is None:
            raise _invalid(f"Unknown visual type {visual.type!r}")

        unknown_options = set(visual.options) - spec.options
        if unknown_options:
            raise _invalid(
                f"Visual {visual.id!r} has unknown option(s): "
                + ", ".join(sorted(unknown_options))
            )

        problems = validate_wells(visual.type, visual.wells)
        if problems:
            raise _invalid(f"Visual {visual.id!r}: {problems[0]}")

    return definition


def to_export_document(definition: ReportDefinition) -> str:
    """Serialise a definition portably: sorted keys, stable indent, trailing newline.

    Two exports of an unchanged report are byte-identical, so the file diffs
    cleanly in version control.
    """
    payload = definition.model_dump(by_alias=True, mode="json")
    return json.dumps(payload, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
