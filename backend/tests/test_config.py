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
        secret_key="a" * 32,
        # The localhost default now trips the production guardrail, as it
        # should -- production fixtures name a real-looking database.
        database_url="postgresql+psycopg://app:pw@db.internal:5432/semanticui",
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


def _prod_kwargs(**overrides):
    kwargs = dict(
        _env_file=None,
        auth_mode="oauth",
        environment="production",
        snowflake_account="a",
        oauth_client_id="b",
        oauth_client_secret="c",
        direct_login_methods=["keypair"],
        secret_key="a" * 32,
        # The localhost default now trips the production guardrail, as it
        # should -- production fixtures name a real-looking database.
        database_url="postgresql+psycopg://app:pw@db.internal:5432/semanticui",
    )
    kwargs.update(overrides)
    return kwargs


def test_production_rejects_default_secret_key():
    with pytest.raises(ValidationError, match="secret_key"):
        Settings(**_prod_kwargs(secret_key="dev-secret-change-me"))


def test_production_rejects_short_secret_key():
    with pytest.raises(ValidationError, match="secret_key"):
        Settings(**_prod_kwargs(secret_key="short-key-not-32-bytes"))


def test_production_accepts_strong_secret_key():
    s = Settings(**_prod_kwargs(secret_key="s" * 32))
    assert s.secret_key == "s" * 32


def test_development_allows_default_secret_key():
    s = Settings(_env_file=None)
    assert s.secret_key == "dev-secret-change-me"


def test_post_login_redirect_url_defaults_to_root():
    s = Settings(_env_file=None)
    assert s.post_login_redirect_url == "/"


def test_post_login_redirect_url_is_configurable():
    s = Settings(_env_file=None, post_login_redirect_url="https://spa.example.com/app")
    assert s.post_login_redirect_url == "https://spa.example.com/app"


def test_describe_cache_ttl_default():
    assert Settings(_env_file=None).describe_cache_ttl_seconds == 300
