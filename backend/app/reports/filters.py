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
    values: list[FilterValue] = Field(min_length=1, max_length=MAX_FILTER_VALUES)


class BetweenFilter(_StrictFilter):
    op: Literal["between"]
    # `from` is a Python keyword, so the attribute is `from_` and the wire
    # name stays `from` via the alias.
    from_: Union[str, float] = Field(alias="from")
    to: Union[str, float]

    @model_validator(mode="after")
    def _ordered_and_same_kind(self) -> "BetweenFilter":
        lo, hi = self.from_, self.to
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


# Discriminated on `op`, so an unknown operator fails at the union itself
# rather than falling through to whichever member happens to accept the
# payload.
Filter = Annotated[
    Union[InFilter, BetweenFilter, RelativeDateFilter],
    Field(discriminator="op"),
]

FilterList = Annotated[list[Filter], Field(max_length=MAX_FILTERS_PER_SCOPE)]
