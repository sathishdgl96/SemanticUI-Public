"""Snowflake needs the USER alongside an OAuth token.

`authenticator=oauth` is not "the token says who you are". The connector
sends a login name too, and Snowflake refuses the pair if it is absent:

    390100 (28000): None: Failed to connect to DB: ...
                    Incorrect username or password was specified.

That leading "None:" is the empty login name. Observed live against a
real Entra tenant, on the first exercise of this path -- unit tests
stubbed connect_oauth and so could never have caught it.

The name is read from the access token's own claims. The signature is
NOT verified here and carries no authority: Snowflake verifies the
token and rejects any user that does not match the claim its security
integration is configured to map. This only decides which name to
present alongside it.
"""

import base64
import json


from app.auth.oauth import identity_from_token
from app.config import Settings
from app.snowflake import connect as sf_connect
from tests.fakes import FakeConnection


def jwt_with(payload: dict) -> str:
    def seg(obj) -> str:
        raw = json.dumps(obj).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    # Signature is deliberately junk: nothing here verifies it.
    return f"{seg({'alg': 'RS256'})}.{seg(payload)}.not-a-signature"


class TestIdentityFromToken:
    def test_upn_is_preferred(self):
        token = jwt_with({
            "upn": "alice@corp.com",
            "preferred_username": "other@corp.com",
            "sub": "abc123",
        })
        assert identity_from_token(token) == "alice@corp.com"

    def test_it_falls_back_through_the_usual_claims(self):
        assert identity_from_token(
            jwt_with({"preferred_username": "bob@corp.com"})
        ) == "bob@corp.com"
        assert identity_from_token(
            jwt_with({"email": "carol@corp.com"})
        ) == "carol@corp.com"
        assert identity_from_token(jwt_with({"sub": "dave"})) == "dave"

    def test_padding_is_handled(self):
        # base64url without padding is the norm in JWTs and naive
        # b64decode raises on it.
        for name in ("a@b.c", "ab@c.de", "abc@d.ef", "abcd@e.fg"):
            assert identity_from_token(jwt_with({"upn": name})) == name

    def test_junk_is_none_not_an_exception(self):
        for bad in ("", "not-a-jwt", "a.b", "a.!!!.c", "a." + "e30" + ".c"):
            assert identity_from_token(bad) in (None, {}.get("x"))

    def test_a_configured_claim_wins(self, monkeypatch):
        token = jwt_with({"upn": "alice@corp.com", "custom_login": "ALICE_SF"})
        assert identity_from_token(token, claim="custom_login") == "ALICE_SF"


class TestConnectPassesTheUser:
    def test_the_user_reaches_the_connector(self, monkeypatch):
        seen = {}
        monkeypatch.setattr(
            sf_connect.snowflake.connector, "connect",
            lambda **kw: seen.update(kw) or FakeConnection(),
        )
        monkeypatch.setattr(
            sf_connect, "get_settings",
            lambda: Settings(_env_file=None, snowflake_account="acct"),
        )
        sf_connect.connect_oauth("tok", user="alice@corp.com")
        assert seen["user"] == "alice@corp.com"
        assert seen["authenticator"] == "oauth"
        assert seen["token"] == "tok"

    def test_no_user_means_no_empty_user_key(self, monkeypatch):
        # Sending user=None is what produced the "None:" login name;
        # the key must be absent rather than empty.
        seen = {}
        monkeypatch.setattr(
            sf_connect.snowflake.connector, "connect",
            lambda **kw: seen.update(kw) or FakeConnection(),
        )
        monkeypatch.setattr(
            sf_connect, "get_settings",
            lambda: Settings(_env_file=None, snowflake_account="acct"),
        )
        sf_connect.connect_oauth("tok")
        assert "user" not in seen


class TestCallbackUsesTheTokenIdentity:
    def test_the_claim_is_handed_to_snowflake(self, make_client, monkeypatch):
        from app.auth import oauth as oauth_mod
        from app.auth.oauth import OAUTH_STATE_COOKIE, TokenResponse
        from tests.test_auth_routes import OAUTH_ENV

        token = jwt_with({"upn": "alice@corp.com"})
        client = make_client(**OAUTH_ENV)

        class StubOAuth:
            def exchange_code(self, code, code_verifier=None):
                return TokenResponse(token, "rt-1", 600)

        seen = {}

        def fake_connect(tok, user=None, role=None, account=None):
            seen["token"], seen["user"] = tok, user
            return FakeConnection()

        monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
        monkeypatch.setattr(oauth_mod, "consume_state", lambda s: ("verifier", None))
        monkeypatch.setattr(sf_connect, "connect_oauth", fake_connect)
        monkeypatch.setattr(sf_connect, "probe_identity",
                            lambda c: ("ACME", "ALICE"))
        client.cookies.set(OAUTH_STATE_COOKIE, "good-state")

        response = client.get(
            "/auth/callback",
            params={"code": "the-code", "state": "good-state"},
            follow_redirects=False,
        )
        assert response.status_code == 303
        assert seen["user"] == "alice@corp.com"


class TestRebuildKeepsTheUser:
    def test_a_rebuilt_connection_still_names_its_user(self, db, monkeypatch):
        # The provider rebuilds OAuth connections from the stored refresh
        # token; it must present the same login name or the rebuild hits
        # the identical 390100.
        from datetime import datetime, timedelta, timezone

        from app.auth.sessions import create_session
        from app.snowflake.provider import ConnectionCache

        sess = create_session(
            db, account="ACME", user="alice@corp.com", mode="oauth",
            access_token="at-1", refresh_token="rt-1",
            access_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        seen = {}

        def fake_connect(tok, user=None, role=None, account=None):
            seen["user"] = user
            return FakeConnection()

        monkeypatch.setattr(sf_connect, "connect_oauth", fake_connect)
        cache = ConnectionCache(idle_ttl=900, max_size=10)
        cache.acquire(db, sess)
        assert seen["user"] == "alice@corp.com"
