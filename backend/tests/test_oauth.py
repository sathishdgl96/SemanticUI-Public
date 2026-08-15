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


def test_make_state_prunes_expired_entries(monkeypatch):
    from app.auth import oauth as oauth_mod

    oauth_mod._states.clear()
    fake_now = [1000.0]
    monkeypatch.setattr(oauth_mod.time, "monotonic", lambda: fake_now[0])

    stale = make_state()
    assert stale in oauth_mod._states

    # Past the TTL: the next make_state() call should prune the stale entry.
    fake_now[0] += oauth_mod._STATE_TTL_SECONDS + 1
    make_state()

    assert stale not in oauth_mod._states


def test_states_dict_is_capped(monkeypatch):
    from app.auth import oauth as oauth_mod

    oauth_mod._states.clear()
    monkeypatch.setattr(oauth_mod, "_STATE_MAX_ENTRIES", 5)
    fake_now = [1000.0]
    monkeypatch.setattr(oauth_mod.time, "monotonic", lambda: fake_now[0])

    created = []
    for i in range(10):
        fake_now[0] += 1  # keep insertion order distinguishable, all still fresh
        created.append(make_state())

    assert len(oauth_mod._states) <= 5
    # The oldest entries should have been dropped first (FIFO/oldest-first).
    for old_state in created[:5]:
        assert old_state not in oauth_mod._states
    for new_state in created[-5:]:
        assert new_state in oauth_mod._states
