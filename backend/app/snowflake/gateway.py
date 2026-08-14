from dataclasses import dataclass
from typing import Any

from snowflake.connector.constants import FIELD_ID_TO_NAME
from snowflake.connector.errors import Error as SnowflakeError

from app.errors import ApiError


@dataclass
class QueryResult:
    columns: list[dict]
    rows: list[list]
    truncated: bool
    sfqid: str | None


def map_snowflake_error(exc: Exception) -> ApiError:
    if isinstance(exc, SnowflakeError):
        errno = getattr(exc, "errno", None)
        message = getattr(exc, "raw_msg", None) or getattr(exc, "msg", None) or str(exc)
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


def run_query(conn: Any, sql: str, *, max_rows: int) -> QueryResult:
    cur = conn.cursor()
    try:
        try:
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
