"""Development sign-in: password, key-pair, or external browser.

This is the path production refuses at startup. The submitted
credential opens the Snowflake connection that becomes the session's
cached connection; the server keeps no copy of the credential, so a
lost connection means signing in again -- accepted, for development.
"""

from typing import Literal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.sessions import create_session, set_session_cookie
from app.auth.throttle import auth_window
from app.config import get_settings
from app.db.base import get_db
from app.errors import ApiError
from app.snowflake import connect as sf_connect
from app.snowflake.provider import get_cache
from app.audit import record

router = APIRouter()


class DevLoginRequest(BaseModel):
    account: str
    user: str
    authenticator: Literal["externalbrowser", "password", "keypair"] = "externalbrowser"
    password: str | None = None
    private_key_pem: str | None = Field(default=None, max_length=16384)
    private_key_passphrase: str | None = None


@router.post("/auth/dev-login")
def dev_login(
    req: DevLoginRequest, request: Request, db: Session = Depends(get_db)
) -> JSONResponse:
    settings = get_settings()
    # Throttle by address AND claimed identity: a brute force burns its
    # own budget, a typo does not lock out the whole office NAT.
    client = request.client.host if request.client else "?"
    throttle_key = f"login:{client}:{req.account}/{req.user}".lower()
    window = auth_window()
    if not window.allowed(throttle_key):
        # Recorded, because throttling engaging is the thing the security
        # board is watching for and the refusal happens BEFORE any of the
        # code that would otherwise write a line. No user id: whoever this
        # is has not proved who they are.
        record(db, "auth.rate_limited", outcome="denied")
        raise ApiError(
            "RATE_LIMITED", 429,
            "Too many sign-in attempts; wait a minute and try again.",
        )
    # The resolved list, not the raw setting: unconfigured means single
    # sign-on only, and the endpoint must refuse what the login page is
    # not offering.
    if req.authenticator not in settings.login_methods():
        raise ApiError(
            "AUTH_FAILED", 400, f"Login method '{req.authenticator}' is not enabled"
        )
    if req.authenticator != "keypair" and settings.auth_mode != "dev":
        raise ApiError("AUTH_FAILED", 400, "Dev login is disabled in oauth mode")
    if settings.snowflake_account and (
        sf_connect.normalize_account(req.account).lower()
        != sf_connect.normalize_account(settings.snowflake_account).lower()
    ):
        raise ApiError(
            "AUTH_FAILED",
            400,
            "This deployment only accepts logins to a fixed Snowflake account",
        )
    try:
        conn = sf_connect.connect_dev(
            account=req.account,
            user=req.user,
            authenticator=req.authenticator,
            password=req.password,
            private_key_pem=req.private_key_pem,
            private_key_passphrase=req.private_key_passphrase,
        )
    except ApiError:
        raise
    except Exception as exc:
        window.register_failure(throttle_key)

        record(db, "auth.login_failed", outcome="failed",
               detail={"method": req.authenticator})
        detail = None if req.authenticator == "keypair" else str(exc)
        raise ApiError("AUTH_FAILED", 401, "Snowflake login failed", detail=detail)
    try:
        account, user = sf_connect.probe_identity(conn)
        sess = create_session(db, account=account, user=user, mode="dev")
    except Exception:
        sf_connect.close_quietly(conn)
        raise
    # This connection is the only copy of the user's credential — there is no
    # stored token to rebuild it from, so it must survive the idle sweep.
    get_cache().put(sess.id, conn, rebuildable=False)

    record(db, "auth.login", user_id=sess.user_id, session_id=sess.id,
           detail={"method": req.authenticator})
    response = JSONResponse(
        {"snowflakeUser": user, "snowflakeAccount": account, "mode": "dev"}
    )
    set_session_cookie(response, sess.id)
    return response
