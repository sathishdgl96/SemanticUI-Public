"""The saved-explore document.

An explore is a QUERY, not a canvas: one semantic view, the fields chosen,
the filters applied and how the rows are ordered and capped. It carries no
layout and no visuals -- that is what a report is for.

Parsed as defensively as a report definition: unknown keys refused rather
than dropped, every list bounded, and the whole document size-capped.
"""

import json

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.errors import ApiError, safe_error_details
from app.reports.filters import FilterList
from app.reports.schema import MAX_REF_LENGTH, ViewRef

SCHEMA_VERSION = 1
MAX_DEFINITION_BYTES = 32768
#: A single query selecting more than this many fields is not an explore any
#: more; it is an export, and the row cap will not save it.
MAX_FIELDS = 50
MAX_ORDER_BY = 5
MAX_ROW_LIMIT = 10000

ExploreRef = Field(max_length=MAX_REF_LENGTH)


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class OrderBy(_Strict):
    field: str = Field(max_length=MAX_REF_LENGTH)
    direction: str = Field(default="asc", pattern="^(asc|desc)$")


class ExploreDefinition(_Strict):
    schemaVersion: int
    name: str = Field(min_length=1, max_length=200)
    view: ViewRef
    dimensions: list[str] = Field(default_factory=list, max_length=MAX_FIELDS)
    metrics: list[str] = Field(default_factory=list, max_length=MAX_FIELDS)
    #: Same filter vocabulary as a report, so a filter means one thing in
    #: this product rather than one thing per surface.
    filters: FilterList = Field(default_factory=list)
    orderBy: list[OrderBy] = Field(default_factory=list, max_length=MAX_ORDER_BY)
    limit: int | None = Field(default=None, ge=1, le=MAX_ROW_LIMIT)


def _invalid(message: str, detail: str | None = None) -> ApiError:
    return ApiError("EXPLORE_INVALID", 400, message, detail=detail)


def parse_definition(raw: dict) -> ExploreDefinition:
    """Validate an untrusted explore document. Raises ApiError on any problem."""
    if not isinstance(raw, dict):
        raise _invalid("An explore definition must be a JSON object")

    if len(json.dumps(raw)) > MAX_DEFINITION_BYTES:
        raise _invalid(f"The definition exceeds the {MAX_DEFINITION_BYTES} byte limit")

    version = raw.get("schemaVersion")
    if version != SCHEMA_VERSION:
        raise _invalid(
            f"Unsupported schemaVersion {version!r}; this build reads version "
            f"{SCHEMA_VERSION}"
        )

    try:
        definition = ExploreDefinition.model_validate(raw)
    except ValidationError as exc:
        # `input` stripped: it would otherwise echo whatever the caller
        # submitted, including anything sensitive, back into the response.
        raise _invalid(
            "The explore definition is not valid",
            detail=str(safe_error_details(exc.errors())),
        )

    view = definition.view
    if not (view.database and view.schema_ and view.name):
        # Unlike a report, an explore is meaningless unbound: it IS a query,
        # and a query with no view to run against cannot be saved and reopened.
        raise _invalid("An explore must name a semantic view")

    if not definition.dimensions and not definition.metrics:
        raise _invalid("An explore must select at least one field")

    seen: set[str] = set()
    for ref in [*definition.dimensions, *definition.metrics]:
        key = ref.upper()
        if key in seen:
            raise _invalid(f"{ref} is selected more than once")
        seen.add(key)

    ids: set[str] = set()
    for f in definition.filters:
        if f.id in ids:
            raise _invalid(f"Duplicate filter id {f.id!r}")
        ids.add(f.id)

    # Ordering by something the explore does not select would be an error at
    # query time; catching it here means a saved explore always reopens.
    for ob in definition.orderBy:
        if ob.field.upper() not in seen:
            raise _invalid(f"Cannot order by {ob.field}: it is not selected")

    return definition


def to_export_document(definition: ExploreDefinition) -> str:
    """Serialise portably: sorted keys, stable indent, trailing newline."""
    payload = definition.model_dump(by_alias=True, mode="json")
    return json.dumps(payload, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
