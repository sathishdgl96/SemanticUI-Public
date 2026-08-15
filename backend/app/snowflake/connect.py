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


def connect_oauth(token: str) -> Any:
    settings = get_settings()
    return snowflake.connector.connect(
        account=settings.snowflake_account,
        authenticator="oauth",
        token=token,
        session_parameters=_session_parameters(),
        paramstyle=PARAMSTYLE,
    )


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


def probe_identity(conn: Any) -> tuple[str, str]:
    cur = conn.cursor()
    try:
        row = cur.execute("SELECT CURRENT_ACCOUNT(), CURRENT_USER()").fetchone()
        return str(row[0]), str(row[1])
    finally:
        cur.close()
