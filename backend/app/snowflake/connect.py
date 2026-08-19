"""Opens Snowflake connections; every connection parameter set here.

qmark paramstyle (server-side binds) and session keep-alive are
deliberate and load-bearing -- see PARAMSTYLE and KEEP_ALIVE below.
"""

from typing import Any

import snowflake.connector
from cryptography.hazmat.primitives import serialization

from app.config import get_settings
from app.errors import ApiError


_HOST_SUFFIX = ".snowflakecomputing.com"


# Every connection binds with "?" placeholders (see app/semantic/predicates.py).
# The connector's default is pyformat, under which "?" is not a placeholder at
# all: cursor.execute(sql, params) then dies inside the connector with
# "TypeError: not all arguments converted during string formatting", client
# side, before Snowflake ever sees the statement. qmark is also the stronger
# choice -- it binds server-side, where pyformat escapes and interpolates.
PARAMSTYLE = "qmark"


def normalize_account(value: str) -> str:
    """Reduce a pasted Snowflake host or console URL to an account identifier.

    The connector appends ".snowflakecomputing.com" itself, so passing a full
    hostname yields a doubled domain that fails DNS as an opaque 250001
    "could not connect", and a URL fails as 251001. Both are unambiguous
    enough to recover. Legacy locators such as "xy12345.us-east-1" contain
    dots legitimately, so only the known host suffix is removed — never
    everything after the first dot.
    """
    account = value.strip()
    for scheme in ("https://", "http://"):
        if account.lower().startswith(scheme):
            account = account[len(scheme) :]
            break
    account = account.split("/", 1)[0]
    if account.lower().endswith(_HOST_SUFFIX):
        account = account[: -len(_HOST_SUFFIX)]
    return account.strip(". ")


def _session_parameters() -> dict:
    return {"STATEMENT_TIMEOUT_IN_SECONDS": get_settings().statement_timeout_seconds}


# Connections live in the provider's cache far longer than Snowflake keeps an
# idle session alive. Without keep-alive the server expires the session while
# the client still reports the connection open, and the next query -- often an
# Excel pivot gesture hours later -- fails with a session-gone error. The
# connector's heartbeat costs nothing per query and removes the whole class.
KEEP_ALIVE = {"client_session_keep_alive": True}


def connect_oauth(token: str, user: str | None = None) -> Any:
    """Open a connection with an OAuth access token.

    `user` is required by Snowflake in practice: without it the connector
    sends an empty login name and Snowflake answers 390100 "Incorrect
    username or password" with a literal "None:" where the name belongs.
    It is passed only when known, so the key is absent rather than empty.
    """
    settings = get_settings()
    kwargs: dict[str, Any] = {
        "account": settings.snowflake_account,
        "authenticator": "oauth",
        "token": token,
        "session_parameters": _session_parameters(),
        "paramstyle": PARAMSTYLE,
        **KEEP_ALIVE,
    }
    if user:
        kwargs["user"] = user
    return snowflake.connector.connect(**kwargs)


def load_private_key(pem: str, passphrase: str | None) -> bytes:
    """Parse a PEM private key into DER bytes for the Snowflake connector.

    Never include the caller's key material in the raised error.
    """
    try:
        key = serialization.load_pem_private_key(
            pem.encode(),
            password=passphrase.encode() if passphrase else None,
        )
    except Exception:
        raise ApiError(
            "AUTH_FAILED",
            401,
            "Could not read the private key. Check the PEM and passphrase.",
        ) from None
    return key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


def connect_keypair(*, account: str, user: str, private_key_der: bytes) -> Any:
    return snowflake.connector.connect(
        account=account,
        user=user,
        private_key=private_key_der,
        session_parameters=_session_parameters(),
        paramstyle=PARAMSTYLE,
        **KEEP_ALIVE,
    )


def connect_dev(
    *,
    account: str,
    user: str,
    authenticator: str,
    password: str | None = None,
    private_key_pem: str | None = None,
    private_key_passphrase: str | None = None,
) -> Any:
    account = normalize_account(account)
    if authenticator == "keypair":
        if not private_key_pem:
            raise ApiError("AUTH_FAILED", 401, "A private key is required")
        return connect_keypair(
            account=account,
            user=user,
            private_key_der=load_private_key(private_key_pem, private_key_passphrase),
        )
    kwargs: dict[str, Any] = {
        "account": account,
        "user": user,
        "session_parameters": _session_parameters(),
        "paramstyle": PARAMSTYLE,
        **KEEP_ALIVE,
    }
    if authenticator == "password":
        kwargs["password"] = password
    else:
        kwargs["authenticator"] = "externalbrowser"
    return snowflake.connector.connect(**kwargs)


def close_quietly(conn: Any) -> None:
    """Best-effort close for a connection that failed after connect().

    Callers use this when a step *after* a successful connect() (e.g.
    probe_identity, create_session) raises. That connection was never
    handed to the provider's cache, so nothing else -- not even the
    background sweeper -- would ever close it; a systematic failure here
    (e.g. Postgres down) would otherwise leak one live Snowflake session
    per login attempt.
    """
    try:
        conn.close()
    except Exception:
        pass


def account_identifier(conn: Any) -> str | None:
    """The ORG-ACCOUNT identifier Snowflake's own clients expect.

    CURRENT_ACCOUNT() returns the account LOCATOR ("RC16948"), which only
    resolves as a hostname in the default region. An account in, say,
    AZURE_CENTRALINDIA needs a region segment appended -- so handing the bare
    locator to Excel produces a server string that simply does not connect.
    The org-account form works everywhere, so that is what we hand out.

    Returns None on any older Snowflake without these functions; the caller
    falls back to the stored locator rather than showing nothing.
    """
    cur = conn.cursor()
    try:
        row = cur.execute(
            "SELECT CURRENT_ORGANIZATION_NAME(), CURRENT_ACCOUNT_NAME()"
        ).fetchone()
    except Exception:
        return None
    finally:
        cur.close()
    if row and row[0] and row[1]:
        return f"{row[0]}-{row[1]}"
    return None


def probe_identity(conn: Any) -> tuple[str, str]:
    cur = conn.cursor()
    try:
        row = cur.execute("SELECT CURRENT_ACCOUNT(), CURRENT_USER()").fetchone()
        return str(row[0]), str(row[1])
    finally:
        cur.close()
