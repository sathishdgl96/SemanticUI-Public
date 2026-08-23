"""Copyable SQL for Excel's own Snowflake connector.

THIS MODULE IS NEVER EXECUTED BY THIS APPLICATION. It produces a statement for
a human to paste into Power Query, which supplies no bind parameters and so
cannot use the placeholders every executed statement here uses.

It deliberately imports no cursor, no connection and no gateway. If you find
yourself wanting to run what this returns, you want
`app.semantic.query.build_semantic_sql` instead -- which binds its values, and
which `test_the_executable_builder_still_uses_placeholders` asserts still does.

Inlining is safe HERE in a way it is not elsewhere: the statement runs in the
user's own Excel, under their own Snowflake role, expressing nothing they could
not already do by hand. The escaping exists so a value containing a quote
produces VALID SQL, not to prevent an escalation that was never available.
"""

from datetime import date, datetime
from typing import Any

from app.reports.filters import BetweenFilter, InFilter, RelativeDateFilter, is_active
from app.semantic.discovery import quote_ident
from app.semantic.predicates import resolve_field, resolve_relative_date
from app.semantic.query import SemanticQueryRequest, build_semantic_sql


def _literal(value: Any) -> str:
    """One SQL literal. Strings quoted with doubled quotes; numbers bare."""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        # pydantic widens an int endpoint to float, so 1 arrives as 1.0.
        # This SQL is read and pasted by a person; "BETWEEN 1 AND 9" is what
        # they typed and what they should see back.
        if isinstance(value, float) and value.is_integer():
            return str(int(value))
        return str(value)
    if isinstance(value, datetime):
        return f"TO_TIMESTAMP('{value.isoformat(sep=' ')}')"
    if isinstance(value, date):
        return f"TO_DATE('{value.isoformat()}')"
    text = str(value).replace("'", "''")
    return f"'{text}'"


def _predicate(detail: dict, f: Any, today: date) -> str:
    table, name = resolve_field(detail, f.field)
    column = f"{quote_ident(table)}.{quote_ident(name)}"

    if isinstance(f, InFilter):
        negated = f.op == "isNot"
        if len(f.values) == 1:
            return f"{column} {'<>' if negated else '='} {_literal(f.values[0])}"
        joined = ", ".join(_literal(v) for v in f.values)
        return f"{column} {'NOT IN' if negated else 'IN'} ({joined})"
    if isinstance(f, BetweenFilter):
        return f"{column} BETWEEN {_literal(f.from_)} AND {_literal(f.to)}"
    if isinstance(f, RelativeDateFilter):
        # Resolved here, because Power Query cannot evaluate "last 30 days".
        start, end = resolve_relative_date(f, today)
        return f"{column} BETWEEN {_literal(start)} AND {_literal(end)}"
    return ""


def build_literal_sql(
    detail: dict, req: SemanticQueryRequest, *, today: date | None = None
) -> str:
    """The same query, with values inlined, for pasting into Excel.

    Identifiers go through the same `resolve_field` and `quote_ident` the
    executable path uses, so an unknown field is rejected here too.
    """
    clock = today or date.today()

    # Built without filters first, so the shape, ORDER BY and LIMIT all come
    # from the one function that knows how to assemble them.
    skeleton = req.model_copy(update={"filters": []})
    sql, params, _ = build_semantic_sql(detail, skeleton, max_rows=1000000)
    assert not params, "the skeleton must carry no parameters"

    # Every filter's field is resolved, active or not: being unfinished is not
    # a way to slip an unvalidated reference into a statement handed to a user.
    for f in req.filters:
        resolve_field(detail, f.field)

    predicates = [_predicate(detail, f, clock) for f in req.filters if is_active(f)]
    if predicates:
        where = "  WHERE " + " AND ".join(predicates)
        head, sep, tail = sql.partition("\n)")
        sql = f"{head}\n{where}{sep}{tail}"
    return sql
