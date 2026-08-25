"""Runs one query and maps connector errors to actionable ApiErrors.

The errno/sqlstate tables turn Snowflake's session-gone errors into
AUTH_EXPIRED, which is what lets callers tell "connection died --
rebuild or re-login" apart from "your query is wrong".
"""

from dataclasses import dataclass
from typing import Any

from snowflake.connector.constants import FIELD_ID_TO_NAME
from snowflake.connector.errors import Error as SnowflakeError
from snowflake.connector.network import ReauthenticationRequest

from app.errors import ApiError, AuthExpiredError

# Snowflake errnos for a session/token that is gone server-side: the
# connection is otherwise fine, but re-authentication is required. Mapped
# to AUTH_EXPIRED (401), which is what the connection cache heals from
# (see ConnectionCache.run) and what the frontend routes to login on.
#
# The OAuth pair matters most: 390318 is what an OAuth session raises once
# its access token has expired, and it used to fall through to QUERY_ERROR
# -- so a person whose app session was fine saw "Failed to load semantic
# views" instead of a refreshed token. The codes are the connector's own
# (snowflake.connector.network).
_AUTH_EXPIRED_ERRNOS = {
    390110,  # ID token expired
    390111,  # session gone
    390114,  # master token expired: "The user must authenticate again"
    390115,  # master token not found
    390144,  # JWT token invalid
    390195,  # ID token invalid for login
    390303,  # OAuth access token invalid (revoked, or the account changed)
    390318,  # OAuth access token expired
    394301,  # JWT token expired
}
# The 08001 sqlstate family ("SQLCLIENT_UNABLE_TO_ESTABLISH_SQLCONNECTION")
# covers session/connection-gone cases that don't always carry one of the
# specific errnos above.
_AUTH_EXPIRED_SQLSTATES = {"08001"}


@dataclass
class QueryResult:
    columns: list[dict]
    rows: list[list]
    truncated: bool
    sfqid: str | None


def _says_token_expired(message: str) -> bool:
    """The message form of the errnos above, for a code this table has not
    met yet. Snowflake's wording for every one of them names the token or
    the session and says it expired, is invalid, or needs re-authentication."""
    text = message.lower()
    subject = "token" in text or "session" in text
    verdict = any(
        word in text for word in ("expired", "invalid", "authenticate again", "is gone")
    )
    return subject and verdict


def map_snowflake_error(exc: Exception) -> ApiError:
    # The connector's signal that its own session renewal failed. It wraps
    # the real ProgrammingError, and is not itself a SnowflakeError.
    if isinstance(exc, ReauthenticationRequest):
        cause = getattr(exc, "cause", None)
        return AuthExpiredError(str(cause) if cause else "Sign in required")
    if isinstance(exc, SnowflakeError):
        errno = getattr(exc, "errno", None)
        sqlstate = getattr(exc, "sqlstate", None)
        message = getattr(exc, "raw_msg", None) or getattr(exc, "msg", None) or str(exc)
        if (
            errno in _AUTH_EXPIRED_ERRNOS
            or sqlstate in _AUTH_EXPIRED_SQLSTATES
            or _says_token_expired(message)
        ):
            return AuthExpiredError(message)
        if errno == 3001 or "insufficient privileges" in message.lower():
            return ApiError("SNOWFLAKE_FORBIDDEN", 403, message)
        if errno in (604, 630) or "timeout" in message.lower():
            return ApiError("TIMEOUT", 504, message)
        return ApiError("QUERY_ERROR", 400, message)
    return ApiError("QUERY_ERROR", 400, str(exc))


def _type_name(type_code: Any) -> str:
    try:
        return FIELD_ID_TO_NAME[type_code]
    except Exception:
        return str(type_code)


def run_query(
    conn: Any, sql: str, *, max_rows: int, params: list[Any] | None = None
) -> QueryResult:
    cur = conn.cursor()
    try:
        try:
            # Values are bound, never interpolated. `params` is positional and
            # lines up with the placeholders build_semantic_sql emitted. The
            # no-params case calls execute with one argument rather than an
            # empty sequence -- those are different calls to the connector.
            if params is not None:
                cur.execute(sql, params)
            else:
                cur.execute(sql)
        except Exception as exc:
            raise map_snowflake_error(exc) from exc
        raw = cur.fetchmany(max_rows + 1)
        truncated = len(raw) > max_rows
        columns = [
            {"name": d.name, "type": _type_name(d.type_code)}
            for d in (cur.description or [])
        ]
        return QueryResult(
            columns=columns,
            rows=[list(r) for r in raw[:max_rows]],
            truncated=truncated,
            sfqid=getattr(cur, "sfqid", None),
        )
    finally:
        cur.close()
