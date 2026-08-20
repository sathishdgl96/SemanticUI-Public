"""Choosing a Snowflake account at login -- from the allow-list, only.

The account decides which host this app points its credentials at, so
it is never taken from the request as given. It is matched against
configuration and carried in the OAuth state, where it cannot be
swapped between the redirect out and the return.
"""

import json
from urllib.parse import parse_qs, urlparse

from app.auth import oauth as oauth_mod
from app.auth.oauth import OAUTH_STATE_COOKIE, TokenResponse
from app.db.models import User
from app.snowflake import connect as sf_connect
from tests.fakes import FakeConnection
from tests.test_auth_routes import OAUTH_ENV

ACCOUNTS = json.dumps(
    [
        {"label": "Production", "account": "myorg-prod"},
        {"label": "Sandbox", "account": "myorg-dev"},
    ]
)


class TestConfig:
    def test_config_lists_the_accounts(self, make_client):
        client = make_client(**OAUTH_ENV, SEMANTICUI_SNOWFLAKE_ACCOUNTS=ACCOUNTS)
        body = client.get("/api/config").json()
        assert [a["label"] for a in body["accounts"]] == ["Production", "Sandbox"]
        assert [a["account"] for a in body["accounts"]] == ["myorg-prod", "myorg-dev"]

    def test_a_single_account_deployment_needs_no_new_setting(self, make_client):
        client = make_client(**OAUTH_ENV)
        body = client.get("/api/config").json()
        assert [a["account"] for a in body["accounts"]] == ["myorg-myaccount"]


class TestLogin:
    def test_an_account_outside_the_list_is_refused(self, make_client):
        client = make_client(**OAUTH_ENV, SEMANTICUI_SNOWFLAKE_ACCOUNTS=ACCOUNTS)
        refused = client.get(
            "/auth/login", params={"account": "attacker-host"}, follow_redirects=False
        )
        assert refused.status_code == 400

    def test_no_account_at_all_still_works(self, make_client):
        client = make_client(**OAUTH_ENV, SEMANTICUI_SNOWFLAKE_ACCOUNTS=ACCOUNTS)
        started = client.get("/auth/login", follow_redirects=False)
        assert started.status_code == 307


def drive_login(client, monkeypatch, account, seen):
    class StubOAuth:
        def authorize_url(self, state, code_challenge=None):
            return f"https://idp.example.com/authorize?state={state}"

        def exchange_code(self, code, code_verifier=None):
            return TokenResponse("at-1", "rt-1", 600)

    def fake_connect(token, user=None, role=None, account=None):
        seen["account"] = account
        return FakeConnection()

    monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
    monkeypatch.setattr(sf_connect, "connect_oauth", fake_connect)
    monkeypatch.setattr(sf_connect, "probe_identity", lambda c: ("ACME", "ALICE"))

    params = {"account": account} if account else {}
    started = client.get("/auth/login", params=params, follow_redirects=False)
    state = parse_qs(urlparse(started.headers["location"]).query)["state"][0]
    client.cookies.set(OAUTH_STATE_COOKIE, state)
    return client.get(
        "/auth/callback",
        params={"code": "the-code", "state": state},
        follow_redirects=False,
    )


class TestTheChosenAccountIsUsed:
    def test_it_reaches_the_connection(self, make_client, monkeypatch):
        client = make_client(**OAUTH_ENV, SEMANTICUI_SNOWFLAKE_ACCOUNTS=ACCOUNTS)
        seen: dict = {}
        assert drive_login(client, monkeypatch, "myorg-dev", seen).status_code == 303
        assert seen["account"] == "myorg-dev"

    def test_without_a_choice_the_configured_default_applies(
        self, make_client, monkeypatch
    ):
        client = make_client(**OAUTH_ENV)
        seen: dict = {}
        assert drive_login(client, monkeypatch, None, seen).status_code == 303
        assert seen["account"] is None  # connect_oauth falls back to settings


class TestRememberedContext:
    def test_a_remembered_role_is_applied_at_login(
        self, make_client, db, monkeypatch
    ):
        client = make_client(**OAUTH_ENV)
        applied: dict = {}

        from app.session import context as context_mod

        monkeypatch.setattr(
            context_mod, "apply_context",
            lambda conn, role, warehouse: applied.update(role=role, warehouse=warehouse),
        )
        # A user who chose a context in an earlier session.
        user = User(
            snowflake_account="ACME", snowflake_user="ALICE",
            last_role="FINANCE", last_warehouse="BIG_WH",
        )
        db.add(user)
        db.commit()

        seen: dict = {}
        assert drive_login(client, monkeypatch, None, seen).status_code == 303
        assert applied == {"role": "FINANCE", "warehouse": "BIG_WH"}

    def test_a_revoked_role_costs_the_user_a_choice_not_their_login(
        self, make_client, db, monkeypatch
    ):
        client = make_client(**OAUTH_ENV)

        from app.session import context as context_mod

        def refuse(conn, role, warehouse):
            raise RuntimeError("390317: role not in token")

        monkeypatch.setattr(context_mod, "apply_context", refuse)
        db.add(User(
            snowflake_account="ACME", snowflake_user="ALICE", last_role="GONE",
        ))
        db.commit()

        seen: dict = {}
        # Signed in regardless: a stale preference must never lock
        # someone out of the product.
        assert drive_login(client, monkeypatch, None, seen).status_code == 303
