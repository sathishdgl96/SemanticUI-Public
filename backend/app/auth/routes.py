from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy.orm import Session

from app.auth import oauth as oauth_mod
from app.auth.oauth import OAuthRefreshError
from app.auth.sessions import (
    SESSION_COOKIE,
    create_session,
    delete_session,
    get_active_session,
    set_session_cookie,
)
from app.config import get_settings
from app.db.base import get_db
from app.db.models import DbSession
from app.errors import ApiError, AuthExpiredError
from app.snowflake import connect as sf_connect
from app.snowflake.provider import get_cache

router = APIRouter()


def current_session(request: Request, db: Session = Depends(get_db)) -> DbSession:
    sid = request.cookies.get(SESSION_COOKIE)
    sess = get_active_session(db, sid) if sid else None
    if sess is None:
        raise AuthExpiredError()
    return sess


@router.get("/auth/login")
def oauth_login() -> RedirectResponse:
    if get_settings().auth_mode != "oauth":
        raise ApiError("AUTH_FAILED", 400, "OAuth login is not available in dev mode")
    client = oauth_mod.get_oauth_client()
    return RedirectResponse(client.authorize_url(oauth_mod.make_state()))


@router.get("/auth/callback")
def oauth_callback(
    code: str, state: str, db: Session = Depends(get_db)
) -> RedirectResponse:
    if get_settings().auth_mode != "oauth":
        raise ApiError("AUTH_FAILED", 400, "OAuth login is not available in dev mode")
    if not oauth_mod.consume_state(state):
        raise ApiError("AUTH_FAILED", 401, "Invalid or expired OAuth state")
    try:
        tok = oauth_mod.get_oauth_client().exchange_code(code)
    except OAuthRefreshError:
        raise ApiError("AUTH_FAILED", 401, "OAuth code exchange failed")
    conn = sf_connect.connect_oauth(tok.access_token)
    account, user = sf_connect.probe_identity(conn)
    sess = create_session(
        db,
        account=account,
        user=user,
        mode="oauth",
        access_token=tok.access_token,
        refresh_token=tok.refresh_token,
        access_expires_at=datetime.now(timezone.utc) + timedelta(seconds=tok.expires_in),
    )
    get_cache().put(sess.id, conn)
    response = RedirectResponse("/", status_code=303)
    set_session_cookie(response, sess.id)
    return response


@router.post("/auth/logout")
def logout(request: Request, db: Session = Depends(get_db)) -> JSONResponse:
    sid = request.cookies.get(SESSION_COOKIE)
    if sid:
        get_cache().evict(sid)
        delete_session(db, sid)
    response = JSONResponse({"ok": True})
    response.delete_cookie(SESSION_COOKIE)
    return response


@router.get("/api/config")
def config() -> dict:
    return {"authMode": get_settings().auth_mode}


@router.get("/api/me")
def me(sess: DbSession = Depends(current_session)) -> dict:
    return {
        "snowflakeUser": sess.user.snowflake_user,
        "snowflakeAccount": sess.user.snowflake_account,
        "mode": sess.mode,
    }
