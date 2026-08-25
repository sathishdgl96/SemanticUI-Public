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
def oauth_login(account: str | None = None) -> RedirectResponse:
    settings = get_settings()
    if settings.auth_mode != "oauth":
        raise ApiError("AUTH_FAILED", 400, "OAuth login is not available in dev mode")
    if not settings.allows_account(account):
        # The account decides which host we hand credentials to, so it
        # comes from configuration and never from the URL.
        raise ApiError("VALIDATION_ERROR", 400, "Unknown account")
    client = oauth_mod.get_oauth_client()
    state = oauth_mod.make_state(account)
    response = RedirectResponse(
        client.authorize_url(state, code_challenge=oauth_mod.challenge_for(state))
    )
    oauth_mod.set_state_cookie(response, state)
    return response


def _reject_oauth_callback(message: str, detail: str | None = None) -> JSONResponse:
    """Refuse the callback, clearing the one-shot state cookie.

    `detail` carries the identity provider's or Snowflake's own words --
    the difference between "wrong audience" and "no such user", which is
    hours of guessing. It reaches the browser in development only: in
    production an unauthenticated caller learns nothing beyond the
    refusal, and the reason is in the log instead.
    """
    if detail and get_settings().environment == "production":
        detail = None
    response = JSONResponse(
        status_code=401,
        content={"code": "AUTH_FAILED", "message": message, "detail": detail},
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

    verifier, account = oauth_mod.consume_state(state)
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
            role=oauth_mod.role_from_token(tok.access_token),
            account=account,
        )
    except Exception as exc:
        # The IdP authenticated the user and issued a token, but Snowflake
        # will not accept it -- the EXTERNAL_OAUTH security integration is
        # missing or does not match (issuer, audience, or the claim mapped
        # to LOGIN_NAME). Raising here reached the browser as a bare
        # INTERNAL_ERROR, which says nothing about which of the three legs
        # failed. The reason goes to the log; the browser gets the leg and
        # the thing to configure, never the token.
        # Claim NAMES, never values: the first question is always whether
        # the mapped claim is even in the token (Snowflake's own verifier
        # calls that EXTERNAL_OAUTH_USER_CLAIM_MISSING).
        present = ",".join(oauth_mod.claim_names(tok.access_token))
        logger.warning(
            "Snowflake refused the IdP token: %s (claims present: %s)",
            exc, present,
        )
        return _reject_oauth_callback(
            "Signed in with your identity provider, but Snowflake refused "
            "the token. Check the EXTERNAL_OAUTH security integration: its "
            "issuer and audience must match the IdP, and the mapped claim "
            "must match the Snowflake user's LOGIN_NAME.",
            # The claim NAMES settle the usual question -- is the mapped
            # claim even in this token, and is it one that names a person
            # rather than an opaque id? Names only, never their values.
            detail=f"{exc} | claims in token: {present}",
        )
    try:
        # Snowflake's own answer for who this is. Deliberately not named
        # `account`: that one is the account CHOSEN at login, and the two
        # are different things (a locator versus an org-account choice).
        probed_account, user = sf_connect.probe_identity(conn)
        sess = create_session(
            db,
            account=probed_account,
            user=user,
            mode="oauth",
            access_token=tok.access_token,
            refresh_token=tok.refresh_token,
            access_expires_at=datetime.now(timezone.utc)
            + timedelta(seconds=tok.expires_in),
        )
        # Remembered so a rebuilt connection reaches the SAME account;
        # the choice otherwise lived only in the short-lived OAuth state.
        sess.snowflake_account_choice = account
        db.commit()
    except Exception:
        sf_connect.close_quietly(conn)
        raise
    from app.session import context

    context.replay_remembered(db, sess, conn)
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
        "directLoginMethods": settings.login_methods(),
        # Labels and identifiers only -- nothing here is secret,
        # and the login page needs it before anyone is signed in.
        "accounts": [c.model_dump() for c in settings.account_choices()],
    }


@router.get("/api/me")
def me(sess: DbSession = Depends(current_session)) -> dict:
    return {
        "snowflakeUser": sess.user.snowflake_user,
        "snowflakeAccount": sess.user.snowflake_account,
        "mode": sess.mode,
    }
