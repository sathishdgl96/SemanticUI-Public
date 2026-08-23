"""What the model is allowed to say, and how little of it is trusted.

The model returns a query SPEC, never SQL. This module parses that spec and
checks every field it names against the describe catalog the caller's own role
produced.

THAT CHECK -- not the prompt wording -- IS THE PROMPT-INJECTION DEFENCE. A
fully hijacked model can at worst produce a strange query over data the user
could already have queried by hand. If you are here to "harden the prompt",
harden this instead.
"""

import json
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.errors import ApiError
from app.reports.filters import FilterList

MAX_QUESTION_LENGTH = 1000
#: A question's answer is meant to be read, not paged through.
MAX_ASK_ROWS = 1000
MAX_REFS = 20

#: Models wrap JSON in ```json fences and surrounding prose constantly.
#: Refusing on that alone would fail most real replies for no good reason.
_JSON_OBJECT = re.compile(r"\{.*\}", re.S)


class OrderBySpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    field: str = Field(max_length=511)
    direction: Literal["asc", "desc"] = "asc"


class AskSpec(BaseModel):
    #: extra="forbid": a model that invents a `sql` key is refused outright
    #: rather than partially honoured.
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    dimensions: list[str] = Field(default_factory=list, max_length=MAX_REFS)
    metrics: list[str] = Field(default_factory=list, max_length=MAX_REFS)
    filters: FilterList = Field(default_factory=list)
    orderBy: list[OrderBySpec] = Field(default_factory=list, max_length=MAX_REFS)
    limit: int | None = Field(default=None, ge=1)
    #: Displayed to the user. NEVER parsed, executed, or trusted for any
    #: decision -- it is allowed to contain anything at all.
    explanation: str = Field(default="", max_length=2000)


def _failed(message: str) -> ApiError:
    return ApiError("ASK_FAILED", 502, message)


def parse_spec(raw_text: str) -> AskSpec:
    """Turn the model's reply into a validated spec, or fail loudly."""
    match = _JSON_OBJECT.search(raw_text or "")
    if match is None:
        raise _failed(
            "The model did not answer with a query. Try rephrasing the question."
        )
    try:
        payload = json.loads(match.group(0))
    except json.JSONDecodeError:
        raise _failed(
            "The model's answer was not valid JSON. Try rephrasing the question."
        ) from None
    if not isinstance(payload, dict):
        raise _failed("The model's answer was not a query.")

    try:
        spec = AskSpec.model_validate(payload)
    except ValidationError as exc:
        # The model's output, not the user's, so naming the problem count is
        # safe and useful when this happens.
        raise _failed(
            f"The model proposed an unusable query ({exc.error_count()} problem(s)). "
            "Try rephrasing the question."
        ) from None

    if not spec.dimensions and not spec.metrics:
        raise _failed(
            "The model's answer selected at least one field: none were given."
        )

    # Clamped rather than trusted: the model is not the authority on how much
    # data a question is worth.
    if spec.limit is None or spec.limit > MAX_ASK_ROWS:
        spec.limit = MAX_ASK_ROWS
    return spec


def _catalog(detail: dict, kind: str) -> set[tuple[str, str]]:
    return {
        ((f.get("table") or "").upper(), f["name"].upper())
        for f in detail.get(kind, [])
    }


def _invalid(ref: str, why: str) -> ApiError:
    return ApiError(
        "ASK_INVALID",
        400,
        f"The model asked for {ref}, which {why}. Try rephrasing the question.",
    )


def _check(refs: list[str], allowed: set[tuple[str, str]], what: str) -> None:
    for ref in refs:
        if "." not in ref:
            raise _invalid(ref, "is not a TABLE.FIELD reference")
        table, name = ref.split(".", 1)
        if (table.upper(), name.upper()) not in allowed:
            raise _invalid(ref, f"is not a {what} in this report's semantic view")


def validate_against_catalog(spec: AskSpec, detail: dict) -> None:
    """Reject anything the caller's own role cannot already see.

    Kinds are checked as well as names: a dimension offered in the metrics slot
    would produce a query that means something other than what was asked.

    `orderBy` is deliberately NOT checked here. `build_semantic_sql` already
    rejects an orderBy field that was not selected, with its own message, and
    duplicating that rule would let the two drift apart.
    """
    dimensions = _catalog(detail, "dimensions")
    metrics = _catalog(detail, "metrics")
    facts = _catalog(detail, "facts")

    _check(spec.dimensions, dimensions, "dimension")
    _check(spec.metrics, metrics, "metric")
    # Filters may name dimensions or facts, matching predicates.py.
    _check([f.field for f in spec.filters], dimensions | facts, "filterable field")
