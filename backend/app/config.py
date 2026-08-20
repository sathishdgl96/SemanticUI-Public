"""Every SEMANTICUI_* environment variable, in one typed place.

Settings are read once per process (lru_cache) and re-read in tests via
cache_clear. The validators are the production guardrail: a deployment
that still carries dev auth, the default secret key, the XMLA trace
flag or a localhost database refuses to boot rather than run insecure.
"""

from functools import lru_cache
from typing import Literal

from pydantic import BaseModel, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_SECRET_KEY = "dev-secret-change-me"
MIN_SECRET_KEY_LENGTH = 32


class AccountChoice(BaseModel):
    """One entry in the login dropdown: what to show, what to connect to."""

    label: str
    account: str


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SEMANTICUI_", env_file=".env", extra="ignore"
    )

    #: The product's display name, and everything branded with it: the shell
    #: and login page, the browser title, the XMLA catalog Excel shows, the
    #: Basic-auth realms. One env var rebrands the whole surface.
    app_name: str = "SemanticUI"
    #: Absolute URL or absolute path to a logo image; absent means the
    #: built-in mark.
    app_logo_url: str | None = None
    #: A logo as a FILE ON DISK; the backend serves it at /api/branding/logo
    #: so the browser never needs filesystem access. app_logo_url wins when
    #: both are set (it is the more explicit instruction).
    app_logo_file: str | None = None

    auth_mode: Literal["oauth", "dev"] = "dev"
    environment: Literal["development", "production"] = "development"
    #: "json" is the container-native stream collectors ingest; "plain" is
    #: for human terminals. Empty means: json in production, plain in dev.
    log_format: Literal["json", "plain", ""] = ""
    #: Where the built SPA lives when this server serves it (the container
    #: image sets this). Empty in development -- Vite serves the frontend.
    static_dir: str = ""
    secret_key: str = DEFAULT_SECRET_KEY
    database_url: str = "postgresql+psycopg://semanticui:semanticui@localhost:5432/semanticui"

    session_ttl_hours: int = 8
    #: Lifetime of an Excel connect token. The session TTL still applies on
    #: top: a token dies with its session no matter what this says.
    connect_token_ttl_hours: int = 24
    connection_idle_ttl_seconds: int = 900
    connection_cache_max: int = 100
    statement_timeout_seconds: int = 60
    row_cap: int = 10000
    describe_cache_ttl_seconds: int = 300

    #: Which Cortex model answers questions. Unavailable on trial accounts.
    cortex_model: str = "llama3.1-70b"
    #: Kill switch, so an operator can turn Q&A off without a deploy.
    ask_enabled: bool = True

    #: Rows per exported sheet. Deliberately far above the 10,000 display cap:
    #: an export is meant to be complete, a screen is not.
    export_row_cap: int = 100000

    # oauth mode only
    snowflake_account: str | None = None  # e.g. "myorg-myaccount"
    oauth_client_id: str | None = None
    oauth_client_secret: str | None = None
    oauth_redirect_uri: str = "http://localhost:8000/auth/callback"

    # --- corporate IdP (Entra ID, Okta) -------------------------------
    # Setting these two switches sign-in from SNOWFLAKE OAuth (Snowflake
    # hosts the login and issues the tokens) to EXTERNAL OAuth (the IdP
    # does, and Snowflake validates them -- ADR 0004). They come as a
    # pair, and the client id/secret then belong to the IdP's app
    # registration rather than to a Snowflake security integration.
    # Entra: https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize
    #        https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
    oauth_authorize_url: str | None = None
    oauth_token_url: str | None = None
    #: Scopes the IdP must mint the token with -- the Snowflake role scope
    #: plus offline_access, or no refresh token comes back. Entra:
    #: "api://<app-id-uri>/session:role:<role> offline_access"
    oauth_scope: str | None = None
    #: Which token claim names the Snowflake user. Empty tries the usual
    #: ones in order (upn, preferred_username, email, sub). Set it when
    #: the IdP carries the login name somewhere else -- it must agree
    #: with EXTERNAL_OAUTH_TOKEN_USER_MAPPING_CLAIM on the integration.
    oauth_user_claim: str | None = None

    #: Accounts offered at login, as JSON: [{"label": ..., "account": ...}].
    #: Absent, `snowflake_account` below is the only choice, so a
    #: single-account deployment needs nothing new.
    snowflake_accounts: list[AccountChoice] = []

    # Where /auth/callback sends the browser after a successful login. The
    # backend does not serve the SPA itself (see README "Serving the SPA
    # in production"), so this must point at wherever the frontend is
    # actually hosted -- "/" only works when a reverse proxy serves the
    # SPA from the same origin as this backend.
    post_login_redirect_url: str = "/"

    #: Direct Snowflake credentials the login page may offer. None means
    #: "not configured", which is NOT the same as an empty list: single
    #: sign-on is the way in, so an unconfigured deployment offers nothing
    #: else -- while dev auth mode, which exists precisely to have a way in
    #: without an IdP, still offers all three. Set it explicitly to opt a
    #: deployment back in; production may only ever name "keypair".
    direct_login_methods: (
        list[Literal["externalbrowser", "password", "keypair"]] | None
    ) = None

    #: Snowflake usernames allowed into the admin area: operations,
    #: the activity log, and the security board. Deliberately from the
    #: environment rather than a database role -- the people who may read
    #: everyone's activity are decided by whoever deploys the app, not by
    #: anybody inside it, and a table row that grants it would be a row
    #: somebody could grant themselves.
    app_admins: list[str] = []

    #: Behind the sign-in card. A URL the browser can reach, or empty for
    #: the built-in gradient.
    login_background_url: str = ""
    #: Shown under the brand on the sign-in page. Empty for none.
    login_tagline: str = ""

    def is_app_admin(self, snowflake_user: str | None) -> bool:
        """Snowflake usernames are case-insensitive and stored upper-cased;
        an admin list typed in any case has to match anyway."""
        if not snowflake_user:
            return False
        wanted = snowflake_user.strip().upper()
        return any(name.strip().upper() == wanted for name in self.app_admins)

    def login_methods(self) -> list[str]:
        """What the login page may actually offer beside single sign-on."""
        if self.direct_login_methods is not None:
            return list(self.direct_login_methods)
        return ["externalbrowser", "password", "keypair"] if self.auth_mode == "dev" else []

    def account_choices(self) -> list[AccountChoice]:
        """What the login page may offer, single-account included."""
        if self.snowflake_accounts:
            return self.snowflake_accounts
        if self.snowflake_account:
            return [
                AccountChoice(label=self.snowflake_account, account=self.snowflake_account)
            ]
        return []

    def allows_account(self, account: str | None) -> bool:
        """Whether a submitted account may be connected to.

        Never trust the request: the account decides which host this app
        points its credentials at, and an allow-list is the whole reason
        that cannot be chosen by whoever crafts the URL.
        """
        if account is None:
            return True
        return any(choice.account == account for choice in self.account_choices())

    @model_validator(mode="after")
    def _guard(self) -> "Settings":
        if self.auth_mode == "dev" and self.environment == "production":
            raise ValueError("AUTH_MODE=dev is not allowed in production")
        if self.auth_mode == "oauth":
            # The endpoints are a pair: half of them silently sends the
            # browser to one issuer and the token request to another.
            if self.oauth_authorize_url and not self.oauth_token_url:
                raise ValueError(
                    "oauth_authorize_url is set, so oauth_token_url is required too"
                )
            if self.oauth_token_url and not self.oauth_authorize_url:
                raise ValueError(
                    "oauth_token_url is set, so oauth_authorize_url is required too"
                )
            if not self.snowflake_account:
                raise ValueError(
                    "oauth mode requires snowflake_account (the account the "
                    "token is spent against, whoever issued it)"
                )
            if not self.oauth_client_id:
                raise ValueError("oauth mode requires oauth_client_id")
            # An external IdP mints a token for whatever scope is asked
            # for. Omit it and Entra rejects the request outright
            # (AADSTS900144) while Okta issues a token whose audience is
            # not Snowflake -- failures a long way from the cause.
            if self.oauth_authorize_url and not self.oauth_scope:
                raise ValueError(
                    "an external IdP requires oauth_scope naming the "
                    "Snowflake role scope (plus offline_access, or no "
                    "refresh token is issued)"
                )
            # An external IdP may register this app as a PUBLIC client (an
            # Entra SPA registration cannot hold a secret); PKCE is what
            # protects the code there. Snowflake OAuth has no such mode.
            if not self.oauth_client_secret and not self.oauth_authorize_url:
                raise ValueError(
                    "oauth mode requires oauth_client_secret unless an "
                    "external IdP (oauth_authorize_url) is configured"
                )
        if self.environment == "production":
            disallowed = [m for m in self.login_methods() if m != "keypair"]
            if disallowed:
                raise ValueError(
                    f"in production, direct_login_methods may contain only 'keypair'; got {disallowed}"
                )
            if self.secret_key == DEFAULT_SECRET_KEY:
                raise ValueError(
                    "secret_key must be overridden (not the published default) in production"
                )
            if len(self.secret_key) < MIN_SECRET_KEY_LENGTH:
                raise ValueError(
                    f"secret_key must be at least {MIN_SECRET_KEY_LENGTH} characters in production"
                )
            import os

            if os.environ.get("SEMANTICUI_XMLA_TRACE"):
                raise ValueError(
                    "SEMANTICUI_XMLA_TRACE writes verbatim wire traffic and "
                    "is a development diagnostic; unset it in production"
                )
            if "localhost" in self.database_url or "127.0.0.1" in self.database_url:
                raise ValueError(
                    "database_url still points at localhost; production "
                    "needs its real database"
                )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
