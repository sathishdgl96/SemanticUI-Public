import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx
from fastapi import Response

from app.config import Settings, get_settings

# Cookie that ties an OAuth login attempt to the browser that started it.
# `_states` alone is not enough: it is process-global with no binding to
# the browser, so any browser presenting a live (unconsumed) state value
# could complete someone else's callback and be signed in as them (login
# CSRF). The cookie is single-use/short-TTL like the state itself.
OAUTH_STATE_COOKIE = "semanticui_oauth_state"

_STATE_TTL_SECONDS = 600
# /auth/login needs no credentials, so an abandoned-flow loop must not be
# able to grow this process-global dict without bound: prune expired
# entries on every insert and cap the total count, dropping the oldest
# entries first once the cap is hit.
_STATE_MAX_ENTRIES = 10_000
_states: dict[str, float] = {}


@dataclass
class TokenResponse:
    access_token: str
    refresh_token: str | None
    expires_in: int


class OAuthRefreshError(Exception):
    pass


def _prune_expired_states() -> None:
    cutoff = time.monotonic() - _STATE_TTL_SECONDS
    expired = [s for s, created in _states.items() if created < cutoff]
    for s in expired:
        _states.pop(s, None)


def _enforce_state_cap() -> None:
    # Dicts preserve insertion order in Python; if still over cap after
    # pruning, drop the oldest entries first (FIFO) rather than let the
    # dict grow without bound.
    overflow = len(_states) - _STATE_MAX_ENTRIES
    if overflow > 0:
        for s in list(_states.keys())[:overflow]:
            _states.pop(s, None)


def make_state() -> str:
    _prune_expired_states()
    state = secrets.token_urlsafe(16)
    _states[state] = time.monotonic()
    _enforce_state_cap()
    return state


def consume_state(state: str) -> bool:
    created = _states.pop(state, None)
    return created is not None and (time.monotonic() - created) < _STATE_TTL_SECONDS


def set_state_cookie(response: Response, state: str) -> None:
    settings = get_settings()
    response.set_cookie(
        OAUTH_STATE_COOKIE,
        state,
        httponly=True,
        secure=settings.auth_mode != "dev",
        samesite="lax",
        max_age=_STATE_TTL_SECONDS,
    )


class SnowflakeOAuthClient:
    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None):
        self._settings = settings
        self._transport = transport

    @property
    def base_url(self) -> str:
        return f"https://{self._settings.snowflake_account}.snowflakecomputing.com"

    def authorize_url(self, state: str) -> str:
        query = urlencode(
            {
                "client_id": self._settings.oauth_client_id,
                "response_type": "code",
                "redirect_uri": self._settings.oauth_redirect_uri,
                "state": state,
            }
        )
        return f"{self.base_url}/oauth/authorize?{query}"

    def _token_request(self, data: dict) -> TokenResponse:
        with httpx.Client(transport=self._transport, timeout=30) as client:
            resp = client.post(
                f"{self.base_url}/oauth/token-request",
                data=data,
                auth=(self._settings.oauth_client_id, self._settings.oauth_client_secret),
            )
        if resp.status_code >= 400:
            raise OAuthRefreshError(f"token endpoint returned {resp.status_code}")
        body = resp.json()
        return TokenResponse(
            access_token=body["access_token"],
            refresh_token=body.get("refresh_token"),
            expires_in=int(body.get("expires_in", 600)),
        )

    def exchange_code(self, code: str) -> TokenResponse:
        return self._token_request(
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self._settings.oauth_redirect_uri,
            }
        )

    def refresh(self, refresh_token: str) -> TokenResponse:
        return self._token_request(
            {"grant_type": "refresh_token", "refresh_token": refresh_token}
        )


def get_oauth_client() -> SnowflakeOAuthClient:
    return SnowflakeOAuthClient(get_settings())
