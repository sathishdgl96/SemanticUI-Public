from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
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
    authenticator: Literal["externalbrowser", "password"] = "externalbrowser"
    password: str | None = None


@router.post("/auth/dev-login")
def dev_login(req: DevLoginRequest, db: Session = Depends(get_db)) -> JSONResponse:
    if get_settings().auth_mode != "dev":
        raise ApiError("AUTH_FAILED", 400, "Dev login is disabled in oauth mode")
    try:
        conn = sf_connect.connect_dev(
            account=req.account,
            user=req.user,
            authenticator=req.authenticator,
            password=req.password,
        )
    except Exception as exc:
        raise ApiError("AUTH_FAILED", 401, "Snowflake login failed", detail=str(exc))
    account, user = sf_connect.probe_identity(conn)
    sess = create_session(db, account=account, user=user, mode="dev")
    get_cache().put(sess.id, conn)
    response = JSONResponse(
        {"snowflakeUser": user, "snowflakeAccount": account, "mode": "dev"}
    )
    set_session_cookie(response, sess.id)
    return response
