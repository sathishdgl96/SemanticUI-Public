"""Sharing against the real account.

A second Snowflake login is needed to prove the property end to end. When
SEMANTICUI_IT_USER_B is unset this module skips with a reason naming exactly
what is missing -- a skip is not a pass, and silence here would read as
coverage that does not exist.
"""

import os

import pytest

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not (
            os.environ.get("SEMANTICUI_IT_ACCOUNT")
            and os.environ.get("SEMANTICUI_IT_USER_B")
        ),
        reason="needs SEMANTICUI_IT_USER_B / _PASSWORD_B: a second real Snowflake login",
    ),
]


def test_two_real_users_hold_two_distinct_connections():
    """Two logins, two connections, one account.

    Sharing is confined to a single Snowflake account, and each member's
    queries run on their own connection -- the two facts this sub-project
    rests on, checked against the real service rather than a fake.
    """
    from app.snowflake import connect as sf_connect

    a = sf_connect.connect_dev(
        account=os.environ["SEMANTICUI_IT_ACCOUNT"],
        user=os.environ["SEMANTICUI_IT_USER"],
        authenticator="password",
        password=os.environ["SEMANTICUI_IT_PASSWORD"],
    )
    b = sf_connect.connect_dev(
        account=os.environ["SEMANTICUI_IT_ACCOUNT"],
        user=os.environ["SEMANTICUI_IT_USER_B"],
        authenticator="password",
        password=os.environ["SEMANTICUI_IT_PASSWORD_B"],
    )
    try:
        assert a is not b
        account_a, user_a = sf_connect.probe_identity(a)
        account_b, user_b = sf_connect.probe_identity(b)
        assert user_a != user_b, "both logins resolved to the same Snowflake user"
        assert account_a == account_b, "sharing is confined to one account"
    finally:
        a.close()
        b.close()
