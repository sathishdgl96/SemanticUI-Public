from typing import Any

import snowflake.connector

from app.config import get_settings


def _session_parameters() -> dict:
    return {"STATEMENT_TIMEOUT_IN_SECONDS": get_settings().statement_timeout_seconds}


def connect_oauth(token: str) -> Any:
    settings = get_settings()
    return snowflake.connector.connect(
        account=settings.snowflake_account,
        authenticator="oauth",
        token=token,
        session_parameters=_session_parameters(),
    )


def connect_dev(
    *, account: str, user: str, authenticator: str, password: str | None = None
) -> Any:
    kwargs: dict[str, Any] = {
        "account": account,
        "user": user,
        "session_parameters": _session_parameters(),
    }
    if authenticator == "password":
        kwargs["password"] = password
    else:
        kwargs["authenticator"] = "externalbrowser"
    return snowflake.connector.connect(**kwargs)


def probe_identity(conn: Any) -> tuple[str, str]:
    cur = conn.cursor()
    try:
        row = cur.execute("SELECT CURRENT_ACCOUNT(), CURRENT_USER()").fetchone()
        return str(row[0]), str(row[1])
    finally:
        cur.close()
