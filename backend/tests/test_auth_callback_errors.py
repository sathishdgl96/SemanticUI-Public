"""When Snowflake refuses the IdP's token, say so usefully.

The sign-in chain has three legs -- the IdP authorizes, the app trades
the code for a token, Snowflake accepts that token -- and only the last
one depends on the EXTERNAL_OAUTH security integration being set up. It
is also the leg that fails first in every new deployment, so its error
has to name the thing that is wrong.

It used to raise straight out of the callback as an unhandled exception:
the browser got {"code":"INTERNAL_ERROR"} with no detail, indicating
nothing about which leg failed or what to configure. Observed live
against a real Entra tenant (Snowflake 390303, "Invalid OAuth access
token") before the integration existed.
"""

from snowflake.connector.errors import DatabaseError

from app.auth import oauth as oauth_mod
from app.auth.oauth import OAUTH_STATE_COOKIE, TokenResponse
from app.snowflake import connect as sf_connect
from tests.fakes import FakeConnection
from tests.test_auth_routes import OAUTH_ENV

TOKEN_REJECTED = DatabaseError(
    msg=("390303 (08001): Failed to connect to DB: "
         "acct.snowflakecomputing.com:443. Invalid OAuth access token."),
    errno=390303,
    sqlstate="08001",
)


def arrive_at_callback(client, monkeypatch, *, connect):
    """Drive a callback whose state and PKCE verifier both check out, so
    only the Snowflake leg can be what fails."""

    class StubOAuth:
        def exchange_code(self, code, code_verifier=None):
            return TokenResponse("at-1", "rt-1", 600)

    monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
    monkeypatch.setattr(
        oauth_mod, "consume_state",
        lambda s: "verifier" if s == "good-state" else None,
    )
    monkeypatch.setattr(sf_connect, "connect_oauth", connect)
    client.cookies.set(OAUTH_STATE_COOKIE, "good-state")
    return client.get(
        "/auth/callback",
        params={"code": "the-code", "state": "good-state"},
        follow_redirects=False,
    )


class TestSnowflakeRefusesTheToken:
    def test_the_answer_is_an_actionable_401_not_a_500(
        self, make_client, monkeypatch
    ):
        client = make_client(**OAUTH_ENV)

        def refuse(token, user=None):
            raise TOKEN_REJECTED

        response = arrive_at_callback(client, monkeypatch, connect=refuse)

        assert response.status_code == 401
        body = response.json()
        assert body["code"] == "AUTH_FAILED"
        message = f"{body['message']} {body.get('detail') or ''}".lower()
        # Names the leg that failed and the thing to go configure.
        assert "snowflake" in message
        assert "security integration" in message

    def test_the_token_never_reaches_the_browser(self, make_client, monkeypatch):
        client = make_client(**OAUTH_ENV)

        def refuse(token, user=None):
            raise TOKEN_REJECTED

        response = arrive_at_callback(client, monkeypatch, connect=refuse)
        assert "at-1" not in response.text

    def test_the_one_shot_state_cookie_is_cleared(self, make_client, monkeypatch):
        # A failed attempt must not leave a live state cookie behind for
        # the next request to reuse.
        client = make_client(**OAUTH_ENV)

        def refuse(token, user=None):
            raise TOKEN_REJECTED

        response = arrive_at_callback(client, monkeypatch, connect=refuse)
        set_cookie = response.headers.get("set-cookie", "")
        assert OAUTH_STATE_COOKIE in set_cookie
        assert "01 Jan 1970" in set_cookie or "Max-Age=0" in set_cookie

    def test_a_working_integration_still_signs_in(self, make_client, monkeypatch):
        client = make_client(**OAUTH_ENV)
        monkeypatch.setattr(sf_connect, "probe_identity", lambda c: ("ACME", "ALICE"))

        response = arrive_at_callback(
            client, monkeypatch, connect=lambda token, user=None: FakeConnection()
        )
        assert response.status_code == 303


class TestDiagnosticsAreDevelopmentOnly:
    """The reason is worth hours in development and worth nothing to an
    unauthenticated stranger in production."""

    def test_development_carries_snowflakes_own_words(
        self, make_client, monkeypatch
    ):
        client = make_client(**OAUTH_ENV)

        def refuse(token, user=None):
            raise TOKEN_REJECTED

        body = arrive_at_callback(client, monkeypatch, connect=refuse).json()
        assert "390303" in (body["detail"] or "")

    def test_production_says_nothing_extra(self, make_client, monkeypatch):
        client = make_client(
            **OAUTH_ENV,
            SEMANTICUI_ENVIRONMENT="production",
            SEMANTICUI_SECRET_KEY="x" * 40,
            SEMANTICUI_DATABASE_URL="postgresql+psycopg://u:p@db.internal:5432/app",
            SEMANTICUI_DIRECT_LOGIN_METHODS='["keypair"]',
        )

        def refuse(token, user=None):
            raise TOKEN_REJECTED

        body = arrive_at_callback(client, monkeypatch, connect=refuse).json()
        assert body["detail"] is None
        assert "390303" not in body["message"]
