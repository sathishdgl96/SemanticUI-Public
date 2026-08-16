"""Turn filters into SQL predicates and an ordered list of values to bind.

THE RULE THIS FILE EXISTS TO ENFORCE: a filter VALUE never becomes SQL text.
Every value leaves here in the `params` list; the only things that reach the
statement are a placeholder and an identifier taken from the DESCRIBE catalog.
If you are about to write an f-string that interpolates a value, stop -- that
is the bug this module was written to make impossible.

Syntax verified against a real account; see
docs/superpowers/specs/2026-08-15-filter-spike-findings.md.
"""

from datetime import date, timedelta
from typing import Any

from app.errors import ApiError
from app.reports.filters import (
    BetweenFilter,
    BlankFilter,
    CompareFilter,
    Filter,
    InFilter,
    RelativeDateFilter,
    TextFilter,
    is_active,
)
from app.semantic.discovery import quote_ident

# Server-side binding with the `qmark` paramstyle. The spike confirmed both
# qmark and pyformat bind inside SEMANTIC_VIEW(); qmark wins because pyformat
# binds CLIENT-side -- the connector escapes the value and interpolates it
# into the statement before sending, which is strictly weaker than never
# putting it there at all.
#
# This requires every connection to be opened with paramstyle="qmark". On a
# default (pyformat) connection a "?" is not a placeholder, and the connector
# raises TypeError before Snowflake ever sees the statement.
PLACEHOLDER = "?"


def _filterable(detail: dict) -> dict[tuple[str, str], tuple[str, str]]:
    """Fields a WHERE clause may name, keyed case-insensitively.

    Dimensions and facts are raw columns. Metrics are aggregates: filtering
    one is a HAVING, a different shape, so they are deliberately absent here
    and `_resolve` reports them specifically rather than as "unknown field".
    """
    catalog: dict[tuple[str, str], tuple[str, str]] = {}
    for kind in ("dimensions", "facts"):
        for f in detail.get(kind, []):
            table, name = f.get("table") or "", f["name"]
            catalog[(table.upper(), name.upper())] = (table, name)
    return catalog


def _metric_refs(detail: dict) -> set[tuple[str, str]]:
    return {
        ((m.get("table") or "").upper(), m["name"].upper())
        for m in detail.get("metrics", [])
    }


def resolve_field(detail: dict, ref: str) -> tuple[str, str]:
    if "." not in ref:
        raise ApiError("QUERY_ERROR", 400, f"Filter field must be TABLE.NAME: {ref}")
    table, name = ref.split(".", 1)
    key = (table.upper(), name.upper())
    hit = _filterable(detail).get(key)
    if hit is not None:
        return hit
    if key in _metric_refs(detail):
        raise ApiError(
            "QUERY_ERROR",
            400,
            f"{ref} is a metric, an aggregate value, so it cannot be filtered "
            "here. Filter on a dimension instead.",
        )
    raise ApiError("QUERY_ERROR", 400, f"Unknown filter field: {ref}")


# Snowflake's literal substring functions, not LIKE.
#
# Two reasons, one of them found the hard way against a real account:
#
#   1. `LIKE ... ESCAPE '\'` is a syntax error inside SEMANTIC_VIEW(). The
#      grammar there is narrower than a plain WHERE and rejects the ESCAPE
#      clause outright ("unexpected 'ESCAPE'").
#   2. These functions have no wildcard semantics AT ALL, so a user searching
#      for "50%" gets rows containing "50%" with nothing to escape. Escaping
#      is not a step that can be got wrong here; it is a step that does not
#      exist. Without that, a stray "%" would silently widen the filter and
#      return more rows than the person asked for -- a wrong answer that
#      looks like a right one.
#
# The value is still BOUND: these take a placeholder like any other operator.
TEXT_FUNCTION = {
    "contains": "CONTAINS",
    "notContains": "CONTAINS",
    "startsWith": "STARTSWITH",
    "endsWith": "ENDSWITH",
}


def _add_months(anchor: date, delta: int) -> date:
    """Shift by whole months, clamped to the 1st. Callers only ever want the
    start of a month, so day-overflow (Jan 31 -> Feb 31) cannot arise."""
    total = anchor.year * 12 + (anchor.month - 1) + delta
    return date(total // 12, total % 12 + 1, 1)


def resolve_relative_date(f: RelativeDateFilter, today: date) -> tuple[date, date]:
    """Resolve a relative window to two concrete dates, inclusive at both ends.

    A window of `count` units *ending today*: "last 7 days" covers seven days,
    the seventh of which is today -- not eight days, and not seven days ending
    yesterday.
    """
    if f.preset == "monthToDate":
        return today.replace(day=1), today
    if f.preset == "yearToDate":
        return today.replace(month=1, day=1), today

    count = f.count or 1
    if f.unit == "day":
        return today - timedelta(days=count - 1), today
    if f.unit == "month":
        return _add_months(today, -(count - 1)), today
    return date(today.year - (count - 1), 1, 1), today


def build_filter_predicates(
    detail: dict, filters: list[Filter], *, today: date | None = None
) -> tuple[list[str], list[Any]]:
    """Return (predicate fragments, values to bind), positionally aligned.

    The caller joins the fragments with AND and hands `params` straight to the
    cursor. Order matters: binding is positional, so a wrong order is a wrong
    answer rather than an error.
    """
    if not filters:
        return [], []

    clock = today or date.today()
    fragments: list[str] = []
    params: list[Any] = []

    for f in filters:
        # Resolve first, then skip: an inactive filter still names a field,
        # and being unfinished is not a way to smuggle an unvalidated
        # reference past the catalog check into a saved report.
        table, name = resolve_field(detail, f.field)
        if not is_active(f):
            # Both the fragment and its params are skipped together. Dropping
            # one without the other would bind every later value to the wrong
            # placeholder -- a wrong answer rather than an error.
            continue
        column = f"{quote_ident(table)}.{quote_ident(name)}"

        if isinstance(f, InFilter):
            negated = f.op == "isNot"
            if len(f.values) == 1:
                fragments.append(f"{column} {'<>' if negated else '='} {PLACEHOLDER}")
            else:
                holders = ", ".join(PLACEHOLDER for _ in f.values)
                fragments.append(f"{column} {'NOT IN' if negated else 'IN'} ({holders})")
            params.extend(f.values)
        elif isinstance(f, TextFilter):
            call = f"{TEXT_FUNCTION[f.op]}({column}, {PLACEHOLDER})"
            fragments.append(f"NOT {call}" if f.op == "notContains" else call)
            params.append(f.value)
        elif isinstance(f, CompareFilter):
            operator = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[f.op]
            fragments.append(f"{column} {operator} {PLACEHOLDER}")
            params.append(f.value)
        elif isinstance(f, BlankFilter):
            # "Blank" covers both NULL and the empty string: to the person
            # reading the report they are the same absence, and PowerBI
            # treats them the same way. No value is bound -- there is none.
            if f.op == "isBlank":
                fragments.append(f"({column} IS NULL OR {column} = '')")
            else:
                fragments.append(f"({column} IS NOT NULL AND {column} <> '')")
        elif isinstance(f, BetweenFilter):
            keyword = "NOT BETWEEN" if f.op == "notBetween" else "BETWEEN"
            fragments.append(f"{column} {keyword} {PLACEHOLDER} AND {PLACEHOLDER}")
            params.extend([f.from_, f.to])
        elif isinstance(f, RelativeDateFilter):
            start, end = resolve_relative_date(f, clock)
            fragments.append(f"{column} BETWEEN {PLACEHOLDER} AND {PLACEHOLDER}")
            params.extend([start, end])
        else:  # pragma: no cover -- the discriminated union forecloses this
            raise ApiError(
                "QUERY_ERROR", 400, f"Unsupported filter operator on {f.field}"
            )

    return fragments, params
