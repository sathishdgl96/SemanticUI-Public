from functools import lru_cache
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SEMANTICUI_", env_file=".env", extra="ignore"
    )

    auth_mode: Literal["oauth", "dev"] = "dev"
    environment: Literal["development", "production"] = "development"
    secret_key: str = "dev-secret-change-me"
    database_url: str = "postgresql+psycopg://semanticui:semanticui@localhost:5432/semanticui"

    session_ttl_hours: int = 8
    connection_idle_ttl_seconds: int = 900
    connection_cache_max: int = 100
    statement_timeout_seconds: int = 60
    row_cap: int = 10000

    # oauth mode only
    snowflake_account: str | None = None  # e.g. "myorg-myaccount"
    oauth_client_id: str | None = None
    oauth_client_secret: str | None = None
    oauth_redirect_uri: str = "http://localhost:8000/auth/callback"

    direct_login_methods: list[Literal["externalbrowser", "password", "keypair"]] = [
        "externalbrowser",
        "password",
        "keypair",
    ]

    @model_validator(mode="after")
    def _guard(self) -> "Settings":
        if self.auth_mode == "dev" and self.environment == "production":
            raise ValueError("AUTH_MODE=dev is not allowed in production")
        if self.auth_mode == "oauth" and not (
            self.snowflake_account and self.oauth_client_id and self.oauth_client_secret
        ):
            raise ValueError(
                "oauth mode requires snowflake_account, oauth_client_id, oauth_client_secret"
            )
        if self.environment == "production":
            disallowed = [m for m in self.direct_login_methods if m != "keypair"]
            if disallowed:
                raise ValueError(
                    f"in production, direct_login_methods may contain only 'keypair'; got {disallowed}"
                )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
