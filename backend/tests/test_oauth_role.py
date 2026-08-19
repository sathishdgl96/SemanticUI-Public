"""The role a token authorizes has to be the role we ask to use.

Snowflake External OAuth with EXTERNAL_OAUTH_ANY_ROLE_MODE = DISABLE
grants exactly the roles the token's `scp` claim names, as
`session:role:<role>`. A connection that requests no role falls back to
the user's DEFAULT_ROLE, and if that is not among them:

    390317 (08001): The role requested in the connection or the default
    role if none was requested in the connection ('SYSADMIN') is not
    listed in the Access Token or was filtered.

Observed live: a token authorizing ANALYST against a user whose default
role was SYSADMIN. Reading the role out of the token means the app asks
for precisely what it was granted, whatever the user's default is.
"""

from app.auth.oauth import role_from_token
from app.config import Settings
from app.snowflake import connect as sf_connect
from tests.fakes import FakeConnection
from tests.test_oauth_identity import jwt_with


class TestRoleFromToken:
    def test_the_session_role_scope_names_the_role(self):
        assert role_from_token(jwt_with({"scp": "session:role:analyst"})) == "analyst"

    def test_it_is_found_among_other_scopes(self):
        token = jwt_with({"scp": "openid profile session:role:reporting offline_access"})
        assert role_from_token(token) == "reporting"

    def test_a_list_valued_scp_works_too(self):
        # Okta and some IdPs send scp as an array rather than a string.
        token = jwt_with({"scp": ["offline_access", "session:role:analyst"]})
        assert role_from_token(token) == "analyst"

    def test_comma_delimited_scopes_are_split(self):
        # EXTERNAL_OAUTH_SCOPE_DELIMITER may be a comma, and IdPs differ.
        token = jwt_with({"scp": "offline_access,session:role:analyst"})
        assert role_from_token(token) == "analyst"

    def test_role_any_means_let_the_default_stand(self):
        # session:role-any authorizes every role the user has; asking for
        # a specific one would narrow it for no reason.
        assert role_from_token(jwt_with({"scp": "session:role-any"})) is None

    def test_no_role_scope_is_none(self):
        assert role_from_token(jwt_with({"scp": "openid profile"})) is None
        assert role_from_token(jwt_with({})) is None
        assert role_from_token("not-a-jwt") is None

    def test_the_scope_claim_may_be_named_scope(self):
        assert role_from_token(jwt_with({"scope": "session:role:analyst"})) == "analyst"


class TestConnectRequestsTheRole:
    def _settings(self):
        return Settings(_env_file=None, snowflake_account="acct")

    def test_the_role_reaches_the_connector(self, monkeypatch):
        seen = {}
        monkeypatch.setattr(
            sf_connect.snowflake.connector, "connect",
            lambda **kw: seen.update(kw) or FakeConnection(),
        )
        monkeypatch.setattr(sf_connect, "get_settings", self._settings)
        sf_connect.connect_oauth("tok", user="alice@corp.com", role="analyst")
        assert seen["role"] == "analyst"

    def test_no_role_means_no_role_key(self, monkeypatch):
        seen = {}
        monkeypatch.setattr(
            sf_connect.snowflake.connector, "connect",
            lambda **kw: seen.update(kw) or FakeConnection(),
        )
        monkeypatch.setattr(sf_connect, "get_settings", self._settings)
        sf_connect.connect_oauth("tok")
        assert "role" not in seen


class TestCallbackAsksForTheGrantedRole:
    def test_the_token_role_is_requested(self, make_client, monkeypatch):
        from app.auth import oauth as oauth_mod
        from app.auth.oauth import OAUTH_STATE_COOKIE, TokenResponse
        from tests.test_auth_routes import OAUTH_ENV

        token = jwt_with({"upn": "alice@corp.com", "scp": "session:role:analyst"})
        client = make_client(**OAUTH_ENV)

        class StubOAuth:
            def exchange_code(self, code, code_verifier=None):
                return TokenResponse(token, "rt-1", 600)

        seen = {}

        def fake_connect(tok, user=None, role=None):
            seen.update(user=user, role=role)
            return FakeConnection()

        monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
        monkeypatch.setattr(oauth_mod, "consume_state", lambda s: "verifier")
        monkeypatch.setattr(sf_connect, "connect_oauth", fake_connect)
        monkeypatch.setattr(sf_connect, "probe_identity", lambda c: ("ACME", "ALICE"))
        client.cookies.set(OAUTH_STATE_COOKIE, "good-state")

        response = client.get(
            "/auth/callback",
            params={"code": "the-code", "state": "good-state"},
            follow_redirects=False,
        )
        assert response.status_code == 303
        assert seen == {"user": "alice@corp.com", "role": "analyst"}


class TestRebuildAsksForItToo:
    def test_a_rebuilt_connection_requests_the_same_role(self, db, monkeypatch):
        from datetime import datetime, timedelta, timezone

        from app.auth.sessions import create_session
        from app.snowflake.provider import ConnectionCache

        token = jwt_with({"upn": "alice@corp.com", "scp": "session:role:analyst"})
        sess = create_session(
            db, account="ACME", user="alice@corp.com", mode="oauth",
            access_token=token, refresh_token="rt-1",
            access_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
        seen = {}

        def fake_connect(tok, user=None, role=None):
            seen.update(user=user, role=role)
            return FakeConnection()

        monkeypatch.setattr(sf_connect, "connect_oauth", fake_connect)
        ConnectionCache(idle_ttl=900, max_size=10).acquire(db, sess)
        assert seen["role"] == "analyst"
