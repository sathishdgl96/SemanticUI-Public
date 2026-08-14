import json
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app.auth.oauth import (
    OAuthRefreshError,
    SnowflakeOAuthClient,
    consume_state,
    make_state,
)
from app.config import Settings


@pytest.fixture
def settings():
    return Settings(
        _env_file=None,
        auth_mode="oauth",
        snowflake_account="myorg-myaccount",
        oauth_client_id="cid",
        oauth_client_secret="csecret",
    )


def test_authorize_url(settings):
    client = SnowflakeOAuthClient(settings)
    url = urlparse(client.authorize_url("state123"))
    assert url.hostname == "myorg-myaccount.snowflakecomputing.com"
    assert url.path == "/oauth/authorize"
    q = parse_qs(url.query)
    assert q["client_id"] == ["cid"]
    assert q["response_type"] == ["code"]
    assert q["state"] == ["state123"]
    assert q["redirect_uri"] == ["http://localhost:8000/auth/callback"]


def _token_transport(status=200, body=None, capture=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if capture is not None:
            capture.append(request)
        payload = body or {
            "access_token": "at-new",
            "refresh_token": "rt-new",
            "expires_in": 600,
        }
        return httpx.Response(status, json=payload)

    return httpx.MockTransport(handler)


def test_exchange_code_posts_form_with_basic_auth(settings):
    seen: list[httpx.Request] = []
    client = SnowflakeOAuthClient(settings, transport=_token_transport(capture=seen))
    tok = client.exchange_code("the-code")
    assert tok.access_token == "at-new"
    assert tok.refresh_token == "rt-new"
    assert tok.expires_in == 600
    req = seen[0]
    assert req.url.path == "/oauth/token-request"
    assert req.headers["authorization"].startswith("Basic ")
    form = parse_qs(req.content.decode())
    assert form["grant_type"] == ["authorization_code"]
    assert form["code"] == ["the-code"]


def test_refresh_raises_on_4xx(settings):
    client = SnowflakeOAuthClient(
        settings, transport=_token_transport(status=400, body={"error": "invalid_grant"})
    )
    with pytest.raises(OAuthRefreshError):
        client.refresh("rt-old")


def test_state_is_single_use():
    s = make_state()
    assert consume_state(s) is True
    assert consume_state(s) is False
    assert consume_state("unknown") is False
