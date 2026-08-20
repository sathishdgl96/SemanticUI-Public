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


def _first_column(conn: Any, sql: str) -> list[str]:
    result = gateway.run_query(conn, sql, max_rows=1000)
    return [str(row[0]) for row in result.rows if row and row[0]]


def available_roles(conn: Any) -> list[str]:
    """Roles granted to the current user, in Snowflake's own order.

    Deduplicated: a role granted both directly and through another is
    one choice to a person, however many grants produced it.
    """
    seen: set[str] = set()
    out: list[str] = []
    for name in _first_column(conn, "SHOW GRANTS TO USER CURRENT_USER()"):
        if name.upper() not in seen:
            seen.add(name.upper())
            out.append(name)
    return out


def available_warehouses(conn: Any) -> list[str]:
    """Warehouses usable under the CURRENT role -- SHOW already filters
    to what the session may see, so no second check is needed."""
    return _first_column(conn, "SHOW WAREHOUSES")


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
