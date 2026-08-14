import pytest
from pydantic import ValidationError

from app.config import Settings


def test_defaults_are_dev_mode():
    s = Settings(_env_file=None)
    assert s.auth_mode == "dev"
    assert s.environment == "development"
    assert s.row_cap == 10000
    assert s.statement_timeout_seconds == 60


def test_dev_mode_refused_in_production():
    with pytest.raises(ValidationError, match="not allowed in production"):
        Settings(_env_file=None, auth_mode="dev", environment="production")


def test_oauth_mode_requires_oauth_settings():
    with pytest.raises(ValidationError, match="oauth mode requires"):
        Settings(_env_file=None, auth_mode="oauth")


def test_oauth_mode_valid_when_configured():
    s = Settings(
        _env_file=None,
        auth_mode="oauth",
        snowflake_account="myorg-myaccount",
        oauth_client_id="cid",
        oauth_client_secret="csecret",
    )
    assert s.oauth_redirect_uri == "http://localhost:8000/auth/callback"


def test_direct_login_methods_default_development():
    s = Settings(_env_file=None)
    assert set(s.direct_login_methods) == {"externalbrowser", "password", "keypair"}


def test_production_allows_only_keypair_direct_login():
    s = Settings(
        _env_file=None,
        auth_mode="oauth",
        environment="production",
        snowflake_account="a",
        oauth_client_id="b",
        oauth_client_secret="c",
        direct_login_methods=["keypair"],
    )
    assert s.direct_login_methods == ["keypair"]

    with pytest.raises(ValidationError, match="only 'keypair'"):
        Settings(
            _env_file=None,
            auth_mode="oauth",
            environment="production",
            snowflake_account="a",
            oauth_client_id="b",
            oauth_client_secret="c",
            direct_login_methods=["password"],
        )
