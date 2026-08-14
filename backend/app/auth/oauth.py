import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx

from app.config import Settings, get_settings

_STATE_TTL_SECONDS = 600
_states: dict[str, float] = {}


@dataclass
class TokenResponse:
    access_token: str
    refresh_token: str | None
    expires_in: int


class OAuthRefreshError(Exception):
    pass


def make_state() -> str:
    state = secrets.token_urlsafe(16)
    _states[state] = time.monotonic()
    return state


def consume_state(state: str) -> bool:
    created = _states.pop(state, None)
    return created is not None and (time.monotonic() - created) < _STATE_TTL_SECONDS


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
