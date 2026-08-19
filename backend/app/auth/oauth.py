"""The OAuth authorization-code client (with PKCE) for Snowflake SSO.

State is single-use and expiring; the PKCE verifier is bound to it, so
an intercepted authorization code is useless without the verifier that
never left this process.
"""

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
#: state -> (created, PKCE code_verifier). The verifier lives and dies
#: with the state: single-use, short TTL, never leaves the server.
_states: dict[str, tuple[float, str]] = {}


#: Claims that carry a login name, best first. Entra puts the UPN in
#: `upn` (v1 tokens) or `preferred_username` (v2); Okta uses `sub`.
_IDENTITY_CLAIMS = ("upn", "preferred_username", "email", "sub")


#: How a Snowflake role travels in an OAuth scope.
_ROLE_PREFIX = "session:role:"
#: The scope that authorizes every role the user holds.
_ROLE_ANY = "session:role-any"


def role_from_token(token: str) -> str | None:
    """The Snowflake role an access token authorizes, if it names one.

    With EXTERNAL_OAUTH_ANY_ROLE_MODE = DISABLE the token's scopes are
    the only roles it may use. A connection that requests none falls
    back to the user's DEFAULT_ROLE, and Snowflake refuses when that is
    not among them (390317) -- which is what happens to anyone whose
    default is an admin role the integration sensibly blocks. Asking for
    the role the token actually carries sidesteps the default entirely.

    Returns None for `session:role-any` (every role is allowed, so
    narrowing to one would be arbitrary) and when no role is named.
    """
    claims = _decode_claims(token)
    if not claims:
        return None
    raw = claims.get("scp") or claims.get("scope") or ""
    scopes = raw if isinstance(raw, list) else str(raw).replace(",", " ").split()
    for scope in scopes:
        text = str(scope).strip()
        if text.lower() == _ROLE_ANY:
            return None
        if text.lower().startswith(_ROLE_PREFIX):
            role = text[len(_ROLE_PREFIX):].strip()
            if role:
                return role
    return None


def claim_names(token: str) -> list[str]:
    """The claim NAMES an access token carries -- never their values.

    When Snowflake refuses a token, the first question is always "is the
    mapped claim even in there?" (its own verifier answers
    EXTERNAL_OAUTH_USER_CLAIM_MISSING). Names alone settle it without
    putting identity in the log.
    """
    claims = _decode_claims(token)
    return sorted(claims) if claims else []


def _decode_claims(token: str) -> dict | None:
    import base64
    import json

    parts = (token or "").split(".")
    if len(parts) != 3:
        return None
    payload = parts[1]
    try:
        # JWTs are base64url WITHOUT padding; b64decode demands it.
        padded = payload + "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(padded))
    except Exception:
        return None
    return claims if isinstance(claims, dict) else None


def identity_from_token(token: str, claim: str | None = None) -> str | None:
    """The login name an OAuth access token claims to carry.

    Snowflake wants the user ALONGSIDE the token: `authenticator=oauth`
    with no user sends an empty login name, and Snowflake answers
    390100 "Incorrect username or password" with a literal "None:" where
    the name should be.

    The signature is deliberately NOT verified and this value carries no
    authority. Snowflake verifies the token itself and refuses any user
    that disagrees with the claim its security integration maps, so a
    forged name cannot buy access -- it only decides which name to
    present. Returns None for anything that is not a readable JWT, which
    leaves the connector's own error to speak.
    """
    claims = _decode_claims(token)
    if claims is None:
        return None
    for name in ((claim,) if claim else _IDENTITY_CLAIMS):
        value = claims.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


@dataclass
class TokenResponse:
    access_token: str
    refresh_token: str | None
    expires_in: int


class OAuthRefreshError(Exception):
    pass


def _created(entry) -> float:
    return entry[0]


def _prune_expired_states() -> None:
    cutoff = time.monotonic() - _STATE_TTL_SECONDS
    expired = [s for s, entry in _states.items() if _created(entry) < cutoff]
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
    # PKCE (RFC 7636): even a stolen authorization code is useless
    # without the verifier, which only this process ever holds.
    verifier = secrets.token_urlsafe(48)
    _states[state] = (time.monotonic(), verifier)
    _enforce_state_cap()
    return state


def challenge_for(state: str) -> str | None:
    """The S256 code challenge for a live state, for the authorize URL."""
    import base64
    import hashlib

    entry = _states.get(state)
    if entry is None:
        return None
    digest = hashlib.sha256(entry[1].encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def consume_state(state: str) -> str | None:
    """Single use: returns the PKCE verifier while the state is live,
    None otherwise. Truthiness keeps the old call-shape working."""
    entry = _states.pop(state, None)
    if entry is None:
        return None
    created, verifier = entry
    if (time.monotonic() - created) >= _STATE_TTL_SECONDS:
        return None
    return verifier


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

    @property
    def external_idp(self) -> bool:
        """True when a corporate IdP issues the tokens (ADR 0004).

        Snowflake OAuth and External OAuth differ on more than the host:
        Snowflake authenticates the token request with HTTP Basic, while
        Entra and Okta expect the credentials in the form body and want
        the scope on every request.
        """
        return bool(self._settings.oauth_authorize_url)

    def authorize_url(self, state: str, code_challenge: str | None = None) -> str:
        params = {
            "client_id": self._settings.oauth_client_id,
            "response_type": "code",
            "redirect_uri": self._settings.oauth_redirect_uri,
            "state": state,
        }
        if self._settings.oauth_scope:
            params["scope"] = self._settings.oauth_scope
        if code_challenge:
            params["code_challenge"] = code_challenge
            params["code_challenge_method"] = "S256"
        endpoint = self._settings.oauth_authorize_url or f"{self.base_url}/oauth/authorize"
        return f"{endpoint}?{urlencode(params)}"

    def _token_request(self, data: dict) -> TokenResponse:
        settings = self._settings
        if self.external_idp:
            endpoint = settings.oauth_token_url
            auth = None
            data = dict(data, client_id=settings.oauth_client_id)
            if settings.oauth_client_secret:
                data["client_secret"] = settings.oauth_client_secret
            if settings.oauth_scope:
                data["scope"] = settings.oauth_scope
        else:
            endpoint = f"{self.base_url}/oauth/token-request"
            auth = (settings.oauth_client_id, settings.oauth_client_secret)
        with httpx.Client(transport=self._transport, timeout=30) as client:
            resp = client.post(endpoint, data=data, auth=auth)
        if resp.status_code >= 400:
            raise OAuthRefreshError(f"token endpoint returned {resp.status_code}")
        body = resp.json()
        return TokenResponse(
            access_token=body["access_token"],
            refresh_token=body.get("refresh_token"),
            expires_in=int(body.get("expires_in", 600)),
        )

    def exchange_code(
        self, code: str, code_verifier: str | None = None
    ) -> TokenResponse:
        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self._settings.oauth_redirect_uri,
        }
        if code_verifier:
            data["code_verifier"] = code_verifier
        return self._token_request(data)

    def refresh(self, refresh_token: str) -> TokenResponse:
        return self._token_request(
            {"grant_type": "refresh_token", "refresh_token": refresh_token}
        )


def get_oauth_client() -> SnowflakeOAuthClient:
    return SnowflakeOAuthClient(get_settings())
