from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.sessions import create_session, set_session_cookie
from app.config import get_settings
from app.db.base import get_db
from app.errors import ApiError
from app.snowflake import connect as sf_connect
from app.snowflake.provider import get_cache

router = APIRouter()


class DevLoginRequest(BaseModel):
    account: str
    user: str
    authenticator: Literal["externalbrowser", "password", "keypair"] = "externalbrowser"
    password: str | None = None
    private_key_pem: str | None = Field(default=None, max_length=16384)
    private_key_passphrase: str | None = None


@router.post("/auth/dev-login")
def dev_login(req: DevLoginRequest, db: Session = Depends(get_db)) -> JSONResponse:
    settings = get_settings()
    if req.authenticator not in settings.direct_login_methods:
        raise ApiError(
            "AUTH_FAILED", 400, f"Login method '{req.authenticator}' is not enabled"
        )
    if req.authenticator != "keypair" and settings.auth_mode != "dev":
        raise ApiError("AUTH_FAILED", 400, "Dev login is disabled in oauth mode")
    if settings.snowflake_account and (
        req.account.strip().lower() != settings.snowflake_account.strip().lower()
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
        detail = None if req.authenticator == "keypair" else str(exc)
        raise ApiError("AUTH_FAILED", 401, "Snowflake login failed", detail=detail)
    try:
        account, user = sf_connect.probe_identity(conn)
        sess = create_session(db, account=account, user=user, mode="dev")
    except Exception:
        sf_connect.close_quietly(conn)
        raise
    get_cache().put(sess.id, conn)
    response = JSONResponse(
        {"snowflakeUser": user, "snowflakeAccount": account, "mode": "dev"}
    )
    set_session_cookie(response, sess.id)
    return response
