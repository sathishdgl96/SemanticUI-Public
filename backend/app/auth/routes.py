"""Sign-in, OAuth callback, logout, /api/me -- the session lifecycle."""

import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request, Response
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

logger = logging.getLogger(__name__)

router = APIRouter()


def current_session(request: Request, db: Session = Depends(get_db)) -> DbSession:
    sid = request.cookies.get(SESSION_COOKIE)
    sess = get_active_session(db, sid) if sid else None
    if sess is None:
        raise AuthExpiredError()
    from app.logging import set_user

    set_user(sess.user_id)
    return sess


@router.get("/auth/login")
def oauth_login() -> RedirectResponse:
    if get_settings().auth_mode != "oauth":
        raise ApiError("AUTH_FAILED", 400, "OAuth login is not available in dev mode")
    client = oauth_mod.get_oauth_client()
    state = oauth_mod.make_state()
    response = RedirectResponse(
        client.authorize_url(state, code_challenge=oauth_mod.challenge_for(state))
    )
    oauth_mod.set_state_cookie(response, state)
    return response


def _reject_oauth_callback(message: str) -> JSONResponse:
    response = JSONResponse(
        status_code=401,
        content={"code": "AUTH_FAILED", "message": message, "detail": None},
    )
    response.delete_cookie(oauth_mod.OAUTH_STATE_COOKIE)
    return response


@router.get("/auth/callback")
def oauth_callback(
    code: str, state: str, request: Request, db: Session = Depends(get_db)
) -> Response:
    if get_settings().auth_mode != "oauth":
        raise ApiError("AUTH_FAILED", 400, "OAuth login is not available in dev mode")

    # The state cookie set by /auth/login ties this callback to the
    # browser that began the flow. Without this check, `state` alone
    # (server-side single-use, but not browser-bound) would let any
    # browser complete any other browser's live login attempt -- a login
    # CSRF that silently signs the victim in as the attacker's identity.
    cookie_state = request.cookies.get(oauth_mod.OAUTH_STATE_COOKIE)
    if not cookie_state or not secrets.compare_digest(cookie_state, state):
        return _reject_oauth_callback("Invalid or expired OAuth state")

    verifier = oauth_mod.consume_state(state)
    if not verifier:
        return _reject_oauth_callback("Invalid or expired OAuth state")
    try:
        tok = oauth_mod.get_oauth_client().exchange_code(code, code_verifier=verifier)
    except OAuthRefreshError:
        return _reject_oauth_callback("OAuth code exchange failed")
    try:
        conn = sf_connect.connect_oauth(
            tok.access_token,
            user=oauth_mod.identity_from_token(
                tok.access_token, claim=get_settings().oauth_user_claim
            ),
        )
    except Exception as exc:
        # The IdP authenticated the user and issued a token, but Snowflake
        # will not accept it -- the EXTERNAL_OAUTH security integration is
        # missing or does not match (issuer, audience, or the claim mapped
        # to LOGIN_NAME). Raising here reached the browser as a bare
        # INTERNAL_ERROR, which says nothing about which of the three legs
        # failed. The reason goes to the log; the browser gets the leg and
        # the thing to configure, never the token.
        logger.warning("Snowflake refused the IdP token: %s", exc)
        return _reject_oauth_callback(
            "Signed in with your identity provider, but Snowflake refused "
            "the token. Check the EXTERNAL_OAUTH security integration: its "
            "issuer and audience must match the IdP, and the mapped claim "
            "must match the Snowflake user's LOGIN_NAME."
        )
    try:
        account, user = sf_connect.probe_identity(conn)
        sess = create_session(
            db,
            account=account,
            user=user,
            mode="oauth",
            access_token=tok.access_token,
            refresh_token=tok.refresh_token,
            access_expires_at=datetime.now(timezone.utc)
            + timedelta(seconds=tok.expires_in),
        )
    except Exception:
        sf_connect.close_quietly(conn)
        raise
    get_cache().put(sess.id, conn)
    response = RedirectResponse(
        get_settings().post_login_redirect_url, status_code=303
    )
    set_session_cookie(response, sess.id)
    response.delete_cookie(oauth_mod.OAUTH_STATE_COOKIE)
    return response


@router.post("/auth/logout")
def logout(request: Request, db: Session = Depends(get_db)) -> JSONResponse:
    sid = request.cookies.get(SESSION_COOKIE)
    if sid:
        sess = get_active_session(db, sid)
        get_cache().evict(sid)
        delete_session(db, sid)
        from app.audit import record

        record(db, "auth.logout",
               user_id=sess.user_id if sess else None, session_id=sid)
    response = JSONResponse({"ok": True})
    response.delete_cookie(SESSION_COOKIE)
    return response


@router.get("/api/config")
def config() -> dict:
    settings = get_settings()
    return {
        "authMode": settings.auth_mode,
        "directLoginMethods": settings.direct_login_methods,
    }


@router.get("/api/me")
def me(sess: DbSession = Depends(current_session)) -> dict:
    return {
        "snowflakeUser": sess.user.snowflake_user,
        "snowflakeAccount": sess.user.snowflake_account,
        "mode": sess.mode,
    }
