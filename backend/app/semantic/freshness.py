"""How current the tables under a semantic view are.

Snowflake has one DML-exact signal, `SYSTEM$LAST_CHANGE_COMMIT_TIME`, and its
documentation forbids the use this page would put it to: "Snowflake recommends
using this value only as a change indicator and strongly discourages users
from treating this value as a timestamp." It is a token, not a clock.

So freshness is derived from two documented columns of
`INFORMATION_SCHEMA.TABLES` instead:

* `LAST_ALTERED` -- "last altered by a DML, DDL, or background metadata
  operation"
* `LAST_DDL` -- "the last DDL operation performed on the table or view"

`LAST_ALTERED` alone would report a table as freshly loaded when somebody
merely added a column. Comparing the two separates a data change from a
definition change, which is the whole point.

The honest limit, which the UI copy carries too: background maintenance such
as auto-clustering also moves `LAST_ALTERED`, so this can over-report slightly.
What it cannot do is claim data is fresh when only the definition changed.

The statement runs on the caller's own connection, so INFORMATION_SCHEMA
filters it to what their role may see. A table they cannot see is simply
absent from the result -- which is why "not visible" is a reported state and
not an error.
"""

import logging
from typing import Any

from app.errors import ApiError
from app.semantic.discovery import execute_dicts, quote_ident
from app.semantic.predicates import PLACEHOLDER

logger = logging.getLogger(__name__)

# Every `state` a freshness row can carry, and the whole vocabulary the UI
# has to word:
#
#   updated          data changed more recently than the definition
#   definition-only  only the definition has moved; no data timestamp
#   not-visible      the caller's role cannot see the table
#   query-backed     a logical table defined by SQL, with no one source
#   unresolved       the model named no base table for it


def _source(table: dict) -> str | None:
    parts = (table.get("baseDatabase"), table.get("baseSchema"), table.get("baseTable"))
    if not all(parts):
        return None
    return ".".join(parts)  # type: ignore[arg-type]


def _lookup(conn: Any, database: str, wanted: list[dict]) -> dict[tuple, dict]:
    """One statement for every table this view reads out of one database.

    Filtered by schema and by name and then matched exactly in Python, rather
    than with a row-value `IN`: the two lists are as long as a semantic view
    has tables, so the over-fetch is a handful of rows, and the query stays
    ordinary SQL that any Snowflake version answers the same way.
    """
    schemas = sorted({t["baseSchema"] for t in wanted})
    names = sorted({t["baseTable"] for t in wanted})
    sql = (
        "SELECT TABLE_SCHEMA, TABLE_NAME, LAST_ALTERED, LAST_DDL, "
        "IS_DYNAMIC, ROW_COUNT "
        f"FROM {quote_ident(database)}.INFORMATION_SCHEMA.TABLES "
        f"WHERE TABLE_SCHEMA IN ({', '.join([PLACEHOLDER] * len(schemas))}) "
        f"AND TABLE_NAME IN ({', '.join([PLACEHOLDER] * len(names))})"
    )
    rows = execute_dicts(conn, sql, tuple(schemas + names))
    return {
        (database, row.get("table_schema"), row.get("table_name")): row
        for row in rows
    }


def source_freshness(conn: Any, tables: list[dict]) -> dict:
    """The freshness block for one semantic view's tables.

    `tables` is what `describe_semantic_view` reports. Never raises: the About
    page has three other blocks to render, and a warehouse that will not start
    is not a reason to show the reader nothing at all.
    """
    resolvable = [
        t for t in tables
        if not t.get("queryBacked") and _source(t) is not None
    ]

    found: dict[tuple, dict] = {}
    available = True
    reason: str | None = None
    by_database: dict[str, list[dict]] = {}
    for table in resolvable:
        by_database.setdefault(table["baseDatabase"], []).append(table)
    for database, wanted in by_database.items():
        try:
            found.update(_lookup(conn, database, wanted))
        except Exception as exc:
            # One unreadable database must not lose the ones that answered --
            # but the reason travels. "The query could not be run" with
            # nothing after it is a dead end for whoever has to fix it, and
            # everywhere else in this product Snowflake's refusals arrive in
            # Snowflake's own words.
            available = False
            reason = exc.message if isinstance(exc, ApiError) else str(exc)
            logger.warning(
                "source freshness failed for database %s: %s", database, exc,
                exc_info=True,
            )

    rows: list[dict] = []
    for table in tables:
        row = {
            "name": table["name"],
            "source": _source(table),
            "state": "unresolved",
            "at": None,
            "isDynamic": False,
            "rowCount": None,
        }
        if table.get("queryBacked"):
            row["state"] = "query-backed"
        elif row["source"] is not None:
            key = (table["baseDatabase"], table["baseSchema"], table["baseTable"])
            info = found.get(key)
            if info is None:
                row["state"] = "not-visible"
            else:
                altered, ddl = info.get("last_altered"), info.get("last_ddl")
                row["isDynamic"] = str(info.get("is_dynamic") or "").upper() == "YES"
                row["rowCount"] = info.get("row_count")
                if altered is not None and (ddl is None or altered > ddl):
                    row["state"] = "updated"
                    row["at"] = altered
                else:
                    row["state"] = "definition-only"
                    row["at"] = ddl
        rows.append(row)

    dated = [r["at"] for r in rows if r["state"] == "updated" and r["at"]]
    return {
        "tables": rows,
        # A report is only as current as its stalest input, so the headline
        # takes the minimum and not the most recent.
        "oldest": min(dated) if dated else None,
        # False the moment any table is not covered by that headline, so the
        # UI never lets one number stand for a partial answer.
        "complete": bool(rows) and all(r["state"] == "updated" for r in rows),
        "available": available,
        "reason": reason,
    }
