"""Filters as they appear in the report definition document.

This module is deliberately SQL-free. It decides what a filter may *say*;
`app/semantic/predicates.py` decides what SQL that becomes. Keeping the two
apart is what makes "values are bound parameters, never SQL text" a property
you can check by reading one module, rather than auditing every place a
filter is read.
"""

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

# A filter with 500 values already produces a 500-placeholder IN list. Past
# that the cost is the user's to justify, not ours to absorb silently.
MAX_FILTER_VALUES = 500
# Snowflake identifiers top out at 255 characters, and so in practice do the
# dimension values worth filtering on by equality.
MAX_VALUE_LENGTH = 255
MAX_FILTERS_PER_SCOPE = 50
# 511 = 255 + "." + 255, the longest legitimate TABLE.FIELD reference.
MAX_REF_LENGTH = 511

FilterValue = Annotated[str, Field(max_length=MAX_VALUE_LENGTH)]


class _StrictFilter(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = Field(min_length=1, max_length=64)
    field: str = Field(min_length=1, max_length=MAX_REF_LENGTH)


class InFilter(_StrictFilter):
    op: Literal["is", "isNot"]
    # No lower bound: an empty list is a filter the user has added but not yet
    # finished, and a report holding one must still save and still query.
    # `is_active` below is what stops it from becoming `IN ()`.
    values: list[FilterValue] = Field(default_factory=list, max_length=MAX_FILTER_VALUES)


class TextFilter(_StrictFilter):
    """Substring matching: PowerBI's "contains", "starts with", "ends with".

    The value stays a plain string here. `predicates.py` is what turns it into
    a LIKE pattern, and it does so by binding -- the wildcards it adds are the
    only ones in the statement, and any the user typed are escaped so they
    match literally rather than silently widening the filter.
    """

    op: Literal["contains", "notContains", "startsWith", "endsWith"]
    value: FilterValue = ""


class CompareFilter(_StrictFilter):
    """Ordered comparison against a single bound value: > >= < <=."""

    op: Literal["gt", "gte", "lt", "lte"]
    # A number or an ISO date string; Snowflake compares either against the
    # column's own type. "" is the unfinished state, kept savable.
    value: Union[str, float] = ""


class BlankFilter(_StrictFilter):
    """Presence tests. These take no value at all, which is exactly why they
    need their own member: an operator that ignored a `value` field would let
    a stale one linger in the document and confuse the next reader."""

    op: Literal["isBlank", "isNotBlank"]


class BetweenFilter(_StrictFilter):
    op: Literal["between", "notBetween"]
    # `from` is a Python keyword, so the attribute is `from_` and the wire
    # name stays `from` via the alias.
    from_: Union[str, float] = Field(alias="from")
    to: Union[str, float]

    @model_validator(mode="after")
    def _ordered_and_same_kind(self) -> "BetweenFilter":
        lo, hi = self.from_, self.to
        # A half-typed range is not yet a range. Ordering and kind only mean
        # something once both ends exist, and rejecting "" here would make a
        # filter unsavable the moment its operator was switched to `between`.
        # `is_active` keeps it out of the query until it is finished.
        if lo == "" or hi == "":
            return self
        if isinstance(lo, str) != isinstance(hi, str):
            raise ValueError("between endpoints must both be numbers or both be dates")
        if lo > hi:  # type: ignore[operator]
            raise ValueError("between requires from <= to")
        return self


class RelativeDateFilter(_StrictFilter):
    op: Literal["relativeDate"]
    unit: Literal["day", "month", "year"] | None = None
    # 3650 days is ten years; past that a relative window is really an
    # absolute one, and `between` is the honest operator for it.
    count: int | None = Field(default=None, ge=1, le=3650)
    preset: Literal["monthToDate", "yearToDate"] | None = None

    @model_validator(mode="after")
    def _exactly_one_form(self) -> "RelativeDateFilter":
        has_window = self.unit is not None and self.count is not None
        has_preset = self.preset is not None
        if has_window and has_preset:
            raise ValueError("relativeDate takes either unit+count or preset, not both")
        if not has_window and not has_preset:
            raise ValueError("relativeDate needs either unit+count or preset")
        if (self.unit is None) != (self.count is None):
            raise ValueError("relativeDate needs unit and count together")
        return self


def is_active(
    f: "InFilter | TextFilter | CompareFilter | BlankFilter | BetweenFilter "
    "| RelativeDateFilter",
) -> bool:
    """Does this filter actually constrain anything yet?

    A half-built filter -- one just added from the field picker, or one whose
    operator was switched a moment ago -- means "not filtering yet", not
    "match nothing". Treating it as a real predicate produces `IN ()`, which
    is neither valid SQL nor a valid request body, and 422s every tile on the
    report. That was a live bug, found by driving the real API in a browser.
    """
    if isinstance(f, InFilter):
        return bool(f.values)
    if isinstance(f, TextFilter):
        # An empty pattern would match every row, which reads as "no filter"
        # far more often than it reads as "rows containing nothing".
        return f.value != ""
    if isinstance(f, CompareFilter):
        # An explicit "" check rather than truthiness: 0 is a real bound.
        return f.value != ""
    if isinstance(f, BlankFilter):
        # A presence test is complete the moment it is chosen.
        return True
    if isinstance(f, BetweenFilter):
        return f.from_ != "" and f.to != ""
    # A relative window always has a resolved unit+count or a preset; the
    # model validator guarantees one of them.
    return True


# Discriminated on `op`, so an unknown operator fails at the union itself
# rather than falling through to whichever member happens to accept the
# payload.
Filter = Annotated[
    Union[
        InFilter,
        TextFilter,
        CompareFilter,
        BlankFilter,
        BetweenFilter,
        RelativeDateFilter,
    ],
    Field(discriminator="op"),
]

FilterList = Annotated[list[Filter], Field(max_length=MAX_FILTERS_PER_SCOPE)]
