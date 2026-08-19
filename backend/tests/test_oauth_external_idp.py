"""Signing in through a corporate IdP (Entra ID, Okta) rather than Snowflake.

Two different products share these settings, and mixing them up is the
easy mistake:

* SNOWFLAKE OAuth -- the client id/secret come from a Snowflake security
  integration, and Snowflake itself hosts /oauth/authorize. This is the
  default and needs no endpoint configuration.
* EXTERNAL OAuth -- the client id/secret come from an IdP app
  registration, the IdP hosts the endpoints, and Snowflake merely
  VALIDATES the tokens it issues (ADR 0004, docs/operations/snowflake-sso.md).

Setting the IdP's endpoints is what switches modes. A public client (an
Entra SPA registration, which cannot hold a secret) is allowed there,
because PKCE is what protects the code.
"""

from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app.auth.oauth import SnowflakeOAuthClient
from app.config import Settings

ENTRA_AUTHORIZE = "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/authorize"
ENTRA_TOKEN = "https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token"
SCOPE = "api://semanticui/session:role:analyst offline_access"


def entra_settings(**over) -> Settings:
    base = dict(
        _env_file=None,
        auth_mode="oauth",
        snowflake_account="myorg-myaccount",
        oauth_client_id="entra-client-id",
        oauth_client_secret="entra-secret",
        oauth_authorize_url=ENTRA_AUTHORIZE,
        oauth_token_url=ENTRA_TOKEN,
        oauth_scope=SCOPE,
        oauth_redirect_uri="https://reports.example.com/auth/callback",
    )
    base.update(over)
    return Settings(**base)


def _transport(capture, status=200, body=None):
    def handler(request: httpx.Request) -> httpx.Response:
        capture.append(request)
        return httpx.Response(status, json=body or {
            "access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600,
        })

    return httpx.MockTransport(handler)


class TestAuthorizeUrl:
    def test_the_browser_is_sent_to_the_idp_not_to_snowflake(self):
        url = urlparse(SnowflakeOAuthClient(entra_settings()).authorize_url("s1"))
        assert url.hostname == "login.microsoftonline.com"
        assert url.path == "/tenant-id/oauth2/v2.0/authorize"
        q = parse_qs(url.query)
        assert q["client_id"] == ["entra-client-id"]
        assert q["scope"] == [SCOPE]
        assert q["redirect_uri"] == ["https://reports.example.com/auth/callback"]

    def test_snowflake_stays_the_default_when_no_endpoints_are_set(self):
        settings = Settings(
            _env_file=None, auth_mode="oauth",
            snowflake_account="myorg-myaccount",
            oauth_client_id="cid", oauth_client_secret="csecret",
        )
        url = urlparse(SnowflakeOAuthClient(settings).authorize_url("s1"))
        assert url.hostname == "myorg-myaccount.snowflakecomputing.com"
        assert "scope" not in parse_qs(url.query)


class TestTokenRequest:
    def test_credentials_travel_in_the_body_for_an_external_idp(self):
        seen: list[httpx.Request] = []
        client = SnowflakeOAuthClient(entra_settings(), transport=_transport(seen))
        client.exchange_code("the-code", code_verifier="v1")

        request = seen[0]
        assert str(request.url) == ENTRA_TOKEN
        form = parse_qs(request.content.decode())
        assert form["client_id"] == ["entra-client-id"]
        assert form["client_secret"] == ["entra-secret"]
        assert form["code_verifier"] == ["v1"]
        assert form["scope"] == [SCOPE]
        # Entra rejects the Basic form Snowflake requires.
        assert "authorization" not in {k.lower() for k in request.headers}

    def test_a_public_client_sends_no_secret(self):
        seen: list[httpx.Request] = []
        settings = entra_settings(oauth_client_secret=None)
        SnowflakeOAuthClient(settings, transport=_transport(seen)).exchange_code(
            "the-code", code_verifier="v1"
        )
        form = parse_qs(seen[0].content.decode())
        assert "client_secret" not in form
        assert form["client_id"] == ["entra-client-id"]

    def test_refresh_carries_the_scope_too(self):
        seen: list[httpx.Request] = []
        client = SnowflakeOAuthClient(entra_settings(), transport=_transport(seen))
        tok = client.refresh("rt-0")
        form = parse_qs(seen[0].content.decode())
        assert form["grant_type"] == ["refresh_token"]
        assert form["scope"] == [SCOPE]
        assert tok.access_token == "at-1"

    def test_snowflake_keeps_using_basic_auth(self):
        seen: list[httpx.Request] = []
        settings = Settings(
            _env_file=None, auth_mode="oauth",
            snowflake_account="myorg-myaccount",
            oauth_client_id="cid", oauth_client_secret="csecret",
        )
        SnowflakeOAuthClient(settings, transport=_transport(seen)).exchange_code("c")
        request = seen[0]
        assert request.headers.get("authorization", "").startswith("Basic ")
        assert "client_secret" not in parse_qs(request.content.decode())


class TestConfigurationGuards:
    def test_a_public_client_is_allowed_only_with_an_external_idp(self):
        entra_settings(oauth_client_secret=None)  # fine: PKCE protects it
        with pytest.raises(ValueError, match="oauth_client_secret"):
            Settings(
                _env_file=None, auth_mode="oauth",
                snowflake_account="myorg-myaccount", oauth_client_id="cid",
            )

    def test_the_two_endpoints_come_as_a_pair(self):
        with pytest.raises(ValueError, match="oauth_token_url"):
            entra_settings(oauth_token_url=None)
        with pytest.raises(ValueError, match="oauth_authorize_url"):
            entra_settings(oauth_authorize_url=None)

    def test_the_snowflake_account_is_still_required(self):
        # It names the account the token is spent against, whoever issued it.
        with pytest.raises(ValueError, match="snowflake_account"):
            entra_settings(snowflake_account=None)

    def test_an_external_idp_must_be_told_which_scope_to_mint(self):
        # Without it Entra refuses the request outright (AADSTS900144) and
        # Okta issues a token with the wrong audience -- both a long way
        # from the missing setting. Refuse at startup, where it is obvious.
        with pytest.raises(ValueError, match="oauth_scope"):
            entra_settings(oauth_scope=None)
