"""The role and warehouse a session runs as.

Applied with USE ROLE / USE WAREHOUSE on the session's existing
connection rather than by reconnecting: it is instant and needs no
fresh token. Two consequences, both deliberate and documented in
docs/superpowers/specs/2026-08-20-session-context-and-finding-design.md:
the change is visible to anything sharing this session's connection (an
open workbook on its connect token, ADR 0003), and switching to a role
the token does not authorise requires EXTERNAL_OAUTH_ANY_ROLE_MODE =
ENABLE on the security integration -- otherwise Snowflake refuses with
390317 and only the token's own role is offered.

Role and warehouse are IDENTIFIERS. They cannot be bound as parameters
the way every VALUE in this codebase is, so the protection is different
in kind: the choice is matched against what Snowflake itself reports the
user may use, and only that matched spelling -- never the caller's
string -- is interpolated, through quote_ident.
"""

from typing import Any

from app.errors import ApiError
from app.semantic.discovery import quote_ident
from app.snowflake import gateway


def _rows(conn: Any, sql: str) -> tuple[list[dict], dict[str, int]]:
    """Rows plus a name->index map.

    Columns are addressed BY NAME. SHOW rowsets are wide and their
    layout is Snowflake's to change: reading column 0 of SHOW GRANTS TO
    USER once yielded `created_on`, a timestamp, which silently emptied
    the role list.
    """
    result = gateway.run_query(conn, sql, max_rows=1000)
    index = {str(col["name"]).lower(): i for i, col in enumerate(result.columns)}
    return result.rows, index


def available_roles(conn: Any) -> list[str]:
    """Roles granted to the current user, in Snowflake's own order.

    SHOW GRANTS TO USER lists direct privilege grants alongside role
    grants, so only the rows `granted_on = ROLE` name a role. It also
    demands an identifier -- `CURRENT_USER()` there is a compilation
    error -- hence the extra round trip to learn the name.
    """
    who, _ = _rows(conn, "SELECT CURRENT_USER()")
    if not who or not who[0] or not who[0][0]:
        return []
    login = str(who[0][0])
    rows, index = _rows(conn, f"SHOW GRANTS TO USER {quote_ident(login)}")

    granted_on = index.get("granted_on")
    name = index.get("name", index.get("role"))
    if granted_on is None or name is None:
        return []

    seen: set[str] = set()
    out: list[str] = []
    for row in rows:
        if str(row[granted_on]).upper() != "ROLE" or not row[name]:
            continue
        role = str(row[name])
        # A role granted more than one way is one choice to a person.
        if role.upper() not in seen:
            seen.add(role.upper())
            out.append(role)
    return out


def available_warehouses(conn: Any) -> list[str]:
    """Warehouses usable under the CURRENT role -- SHOW already filters
    to what the session may see, so no second check is needed."""
    rows, index = _rows(conn, "SHOW WAREHOUSES")
    column = index.get("name")
    if column is None:
        return []
    return [str(row[column]) for row in rows if row[column]]


def current_context(conn: Any) -> dict[str, str | None]:
    """What the connection is ACTUALLY running as.

    Reported instead of the stored preference: an apply can fail halfway
    (USE ROLE succeeds, USE WAREHOUSE does not), and a profile menu
    confidently naming a role the session is not in is worse than one
    that says nothing.
    """
    rows, _ = _rows(conn, "SELECT CURRENT_ROLE(), CURRENT_WAREHOUSE()")
    if not rows or not rows[0]:
        return {"role": None, "warehouse": None}
    role, warehouse = rows[0][0], rows[0][1]
    return {
        "role": str(role) if role else None,
        "warehouse": str(warehouse) if warehouse else None,
    }


def resolve(choice: str | None, allowed: list[str], kind: str) -> str | None:
    """The allowed spelling of `choice`, or refuse.

    Returning the ALLOWED string rather than the caller's is what makes
    the later interpolation safe: whatever arrived over HTTP is
    discarded once it has served as a lookup key.
    """
    if choice is None or not choice.strip():
        return None
    match = next((a for a in allowed if a.upper() == choice.strip().upper()), None)
    if match is None:
        raise ApiError(
            "VALIDATION_ERROR", 400, f"That {kind} is not available to you"
        )
    return match


def apply_context(conn: Any, role: str | None, warehouse: str | None) -> None:
    """Switch the connection. Callers pass values from `resolve` only."""
    cur = conn.cursor()
    try:
        if role:
            cur.execute(f"USE ROLE {quote_ident(role)}")
        if warehouse:
            cur.execute(f"USE WAREHOUSE {quote_ident(warehouse)}")
    finally:
        cur.close()
