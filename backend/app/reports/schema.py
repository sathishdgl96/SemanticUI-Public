"""The portable report definition document.

This is exactly what `GET /api/reports/{id}/export` emits and what
`POST /api/reports/import` accepts, so it is parsed defensively: unknown keys
are refused rather than dropped, every visual is checked against the catalog,
and the whole thing is size-bounded.
"""

import json
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.errors import ApiError, safe_error_details
from app.reports.catalog import CATALOG, HIERARCHY_PREFIX, validate_wells
from app.reports.filters import FilterList
from app.reports.migrate import migrate_definition

SCHEMA_VERSION = 3
MAX_VISUALS = 50
MAX_PAGES = 20
MAX_PAGE_NAME = 100
MAX_DEFINITION_BYTES = 65536
MAX_HIERARCHIES = 20
MAX_HIERARCHY_LEVELS = 10

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
    #: A composite model, instead of one semantic view. Set, the three
    #: fields above stay empty and every field reference is in the
    #: model's namespace -- so a report over a model is the same document
    #: with a different source, not a second kind of report.
    compositeId: str | None = Field(default=None, max_length=64)


class VisualLayout(_Strict):
    x: int = Field(ge=0, le=11)
    y: int = Field(ge=0, le=999)
    w: int = Field(ge=1, le=12)
    h: int = Field(ge=1, le=100)


class Hierarchy(_Strict):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=200)
    levels: list[WellRef] = Field(min_length=1, max_length=MAX_HIERARCHY_LEVELS)


class Visual(_Strict):
    id: str = Field(min_length=1, max_length=64)
    type: str
    title: str = Field(default="", max_length=200)
    layout: VisualLayout
    wells: dict[str, WellRefs] = Field(default_factory=dict)
    options: dict[str, object] = Field(default_factory=dict)
    filters: FilterList = Field(default_factory=list)


class Page(_Strict):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=MAX_PAGE_NAME)
    #: "canvas" is the tile grid. "sheet" is the Excel-like page: one
    #: full-bleed pivot (matrix or table) whose wells the Data pane drives
    #: directly. Filters compose exactly as on a canvas page -- report,
    #: page, then the pivot's own.
    kind: Literal["canvas", "sheet"] = "canvas"
    visuals: list[Visual] = Field(default_factory=list)
    filters: FilterList = Field(default_factory=list)


#: `#rgb` or `#rrggbb`. Constrained rather than free text because these
#: values are written into `style` attributes in the browser -- a pattern is
#: what stops "red; background: url(...)" ever being one of them.
HEX_COLOR = r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$"


class CanvasSettings(_Strict):
    columns: int = Field(default=12, ge=1, le=24)
    rowHeight: int = Field(default=40, ge=10, le=200)
    #: The page behind the tiles. Absent means the product's own canvas grey.
    background: str | None = Field(default=None, pattern=HEX_COLOR)


class ReportDefinition(_Strict):
    schemaVersion: int
    name: str = Field(min_length=1, max_length=200)
    view: ViewRef
    canvas: CanvasSettings = Field(default_factory=CanvasSettings)
    pages: list[Page] = Field(min_length=1, max_length=MAX_PAGES)
    #: The all-pages scope. Page and visual scopes live on their owners.
    filters: FilterList = Field(default_factory=list)
    hierarchies: list[Hierarchy] = Field(
        default_factory=list, max_length=MAX_HIERARCHIES
    )

    def all_visuals(self):
        for page in self.pages:
            yield from page.visuals


def _invalid(message: str, detail: str | None = None) -> ApiError:
    return ApiError("REPORT_INVALID", 400, message, detail=detail)


def parse_definition(raw: dict) -> ReportDefinition:
    """Validate an untrusted definition document. Raises ApiError on any problem."""
    if not isinstance(raw, dict):
        raise _invalid("A report definition must be a JSON object")

    # Upgrade first: the model below demands the current schemaVersion exactly
    # and forbids unknown keys, so a v1 document has to become a v2 document
    # before it is ever handed to pydantic.
    raw = migrate_definition(raw)

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

    pages = raw.get("pages")
    if isinstance(pages, list):
        total = sum(
            len(p["visuals"])
            for p in pages
            if isinstance(p, dict) and isinstance(p.get("visuals"), list)
        )
        if total > MAX_VISUALS:
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
    is_unbound = not view.compositeId and (
        not view.database or not view.schema_ or not view.name
    )
    if is_unbound and any(page.visuals for page in definition.pages):
        raise _invalid(
            "This report must be bound to a semantic view or a model before "
            "it can hold visuals. Pick one first, or remove its visuals."
        )

    seen_page_ids: set[str] = set()
    seen_page_names: set[str] = set()
    for page in definition.pages:
        if page.id in seen_page_ids:
            raise _invalid(f"Duplicate page id {page.id!r}")
        seen_page_ids.add(page.id)
        # Names too: tabs are addressed by name, and PowerBI refuses
        # duplicates for the same reason.
        if page.name in seen_page_names:
            raise _invalid(f"Duplicate page name {page.name!r}")
        seen_page_names.add(page.name)
        if page.kind == "sheet":
            if len(page.visuals) > 1:
                raise _invalid(
                    f"Sheet page {page.name!r} holds a single pivot, not "
                    f"{len(page.visuals)} visuals"
                )
            if page.visuals and page.visuals[0].type not in ("matrix", "table"):
                raise _invalid(
                    f"Sheet page {page.name!r} must hold a matrix or table, "
                    f"not {page.visuals[0].type!r}"
                )

    seen_ids: set[str] = set()
    for visual in definition.all_visuals():
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

    _check_unique_filter_ids(definition)
    _check_hierarchies(definition)

    return definition


def _check_unique_filter_ids(definition: ReportDefinition) -> None:
    """Filter ids must be unique within their scope, so the UI can address one."""
    scopes: list[tuple[str, list]] = [("report", list(definition.filters))]
    scopes += [(f"page {p.id!r}", list(p.filters)) for p in definition.pages]
    scopes += [
        (f"visual {v.id!r}", list(v.filters)) for v in definition.all_visuals()
    ]
    for scope, filters in scopes:
        seen: set[str] = set()
        for f in filters:
            if f.id in seen:
                raise _invalid(f"Duplicate filter id {f.id!r} in {scope} filters")
            seen.add(f.id)


def _check_hierarchies(definition: ReportDefinition) -> None:
    by_id: dict[str, Hierarchy] = {}
    for hierarchy in definition.hierarchies:
        if hierarchy.id in by_id:
            raise _invalid(f"Duplicate hierarchy id {hierarchy.id!r}")
        if len(hierarchy.levels) < 2:
            raise _invalid(
                f"Hierarchy {hierarchy.name!r} needs at least two levels; a "
                "one-level hierarchy is just a field"
            )
        seen_levels: set[str] = set()
        for level in hierarchy.levels:
            if level.upper() in seen_levels:
                raise _invalid(
                    f"Hierarchy {hierarchy.name!r} lists {level} more than once"
                )
            seen_levels.add(level.upper())
        by_id[hierarchy.id] = hierarchy

    for visual in definition.all_visuals():
        spec = CATALOG[visual.type]
        for well_key, refs in visual.wells.items():
            for ref in refs:
                if not ref.startswith(HIERARCHY_PREFIX):
                    continue
                well = spec.well(well_key)
                # A hierarchy is a drill path through dimensions; a metric well
                # holds aggregates, so the reference is meaningless there.
                if well is not None and well.kind != "dimension":
                    raise _invalid(
                        f"Visual {visual.id!r}: {well.label} takes metrics, so it "
                        f"cannot hold the hierarchy reference {ref!r}"
                    )
                if ref[len(HIERARCHY_PREFIX):] not in by_id:
                    raise _invalid(
                        f"Visual {visual.id!r} references {ref!r}, but this report "
                        "declares no such hierarchy"
                    )


def to_export_document(definition: ReportDefinition) -> str:
    """Serialise a definition portably: sorted keys, stable indent, trailing newline.

    Two exports of an unchanged report are byte-identical, so the file diffs
    cleanly in version control.
    """
    payload = definition.model_dump(by_alias=True, mode="json")
    return json.dumps(payload, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
