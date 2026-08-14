# Foundation (Auth + Query Gateway + Semantic View Explorer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user authenticates with their own Snowflake identity (OAuth or dev-mode externalbrowser/password), browses semantic views they are entitled to, and runs ad-hoc dimension/metric queries rendered as a table + basic chart — every Snowflake statement executing on a connection authenticated as that user.

**Architecture:** React SPA -> FastAPI backend (sync endpoints; the Snowflake connector is synchronous) -> per-user connection cache behind a ConnectionProvider -> Snowflake. PostgreSQL stores only app bookkeeping (users, sessions with Fernet-encrypted OAuth tokens). The backend generates all SQL from structured requests; no raw SQL is accepted from the browser.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0 + Alembic, snowflake-connector-python, httpx, cryptography (Fernet), psycopg; React 18 + TypeScript + Vite, TanStack Query, react-router-dom, ECharts; pytest, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-14-foundation-auth-query-gateway-design.md`

## Global Constraints

- Python >= 3.12; Node >= 20.
- All FastAPI endpoints are **sync `def`** (FastAPI runs them in its threadpool); locks are `threading.Lock`, never asyncio locks.
- Backend env vars use prefix `SEMANTICUI_` (e.g. `SEMANTICUI_AUTH_MODE`), loaded from `.env` via pydantic-settings.
- `AUTH_MODE=dev` with `ENVIRONMENT=production` must refuse to start.
- Tokens: Fernet-encrypted at rest, NEVER logged, NEVER returned in any response body.
- Session cookie name: `semanticui_session`; `HttpOnly; SameSite=Lax`; `Secure` unless `auth_mode == "dev"`.
- Error envelope everywhere: `{"code": str, "message": str, "detail": str | null}`. Codes: `AUTH_EXPIRED` (401), `AUTH_FAILED` (401), `SNOWFLAKE_FORBIDDEN` (403), `QUERY_ERROR` (400), `TIMEOUT` (504). No stack traces in responses.
- All Snowflake SQL is built server-side; identifiers are validated/quoted (`quote_ident`) — reject any identifier containing `"`.
- Defaults: session inactivity TTL 8h; connection idle TTL 900s; connection cache max 100; statement timeout 60s; row cap 10000.
- When patching in tests, modules import sibling modules (`from app.snowflake import connect as sf_connect`) and call `sf_connect.fn(...)` so `monkeypatch.setattr` works.
- TDD: every task writes the failing test first. Commit at the end of every task.
- Frontend is light-theme only in this sub-project, but all chart colors go through the constants in `src/query/palette.ts` (validated palette; do not invent colors).

## File Map (who owns what)

```
backend/
  pyproject.toml, .env.example, alembic.ini
  app/main.py            # create_app(), lifespan (cache sweeper thread)
  app/config.py          # Settings, get_settings()
  app/errors.py          # ApiError, AuthExpiredError, register_error_handlers
  app/db/base.py         # Base, get_engine(), get_db()
  app/db/models.py       # User, DbSession
  app/auth/crypto.py     # encrypt_token/decrypt_token (Fernet)
  app/auth/sessions.py   # create_session, get_active_session, delete_session, cookie helpers
  app/auth/oauth.py      # SnowflakeOAuthClient, TokenResponse, state store
  app/auth/routes.py     # /auth/login, /auth/callback, /auth/logout, /api/config, /api/me, current_session dep
  app/auth/dev.py        # /auth/dev-login
  app/snowflake/connect.py   # connect_oauth, connect_dev, probe_identity
  app/snowflake/provider.py  # CacheEntry, ConnectionCache, get_cache(), reset_cache()
  app/snowflake/gateway.py   # run_query, map_snowflake_error, QueryResult
  app/semantic/discovery.py  # quote_ident, list_semantic_views, describe_semantic_view
  app/semantic/query.py      # build_semantic_sql, resolve_fields
  app/semantic/routes.py     # GET /api/semantic-views..., POST /api/query/semantic
  migrations/                # alembic env + versions/0001_initial.py
  tests/                     # unit tests + tests/fakes.py + tests/integration/
frontend/
  src/api/client.ts      # apiFetch, ApiError, setOnAuthExpired
  src/api/types.ts       # shared response types
  src/App.tsx            # router + query client + auth guard
  src/auth/LoginPage.tsx
  src/explorer/ExplorerPage.tsx, ViewTree.tsx, FieldPanel.tsx
  src/query/QueryPanel.tsx, ResultsTable.tsx, AutoChart.tsx, chooseChart.ts, palette.ts
docker-compose.yml       # postgres:16 for local dev
```

---

### Task 1: Backend scaffold, Settings, error envelope, healthz

**Files:**
- Create: `backend/pyproject.toml`, `backend/app/__init__.py`, `backend/app/config.py`, `backend/app/errors.py`, `backend/app/main.py`, `backend/.env.example`, `docker-compose.yml`, `.gitignore`
- Test: `backend/tests/test_config.py`, `backend/tests/test_app.py`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `get_settings() -> Settings` (fields listed below), `ApiError(code, status, message, detail=None)`, `AuthExpiredError()`, `register_error_handlers(app)`, `create_app() -> FastAPI` (later tasks add routers to it), `GET /healthz -> {"status":"ok"}`.

- [ ] **Step 1: Create project scaffolding (no test needed for inert config files)**

`.gitignore` (repo root):

```
.venv/
__pycache__/
*.pyc
.env
node_modules/
frontend/dist/
.pytest_cache/
```

`docker-compose.yml` (repo root):

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: semanticui
      POSTGRES_PASSWORD: semanticui
      POSTGRES_DB: semanticui
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

`backend/pyproject.toml`:

```toml
[project]
name = "semanticui-backend"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "sqlalchemy>=2.0",
    "alembic>=1.13",
    "pydantic-settings>=2.4",
    "snowflake-connector-python>=3.12",
    "httpx>=0.27",
    "cryptography>=43",
    "psycopg[binary]>=3.2",
]

[project.optional-dependencies]
dev = ["pytest>=8", "pytest-mock>=3.14"]

[tool.pytest.ini_options]
markers = ["integration: tests that need a real Snowflake account (env-gated)"]
addopts = "-m 'not integration'"

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["app*"]
```

`backend/.env.example`:

```
SEMANTICUI_AUTH_MODE=dev
SEMANTICUI_ENVIRONMENT=development
SEMANTICUI_SECRET_KEY=change-me-32-bytes-of-entropy
SEMANTICUI_DATABASE_URL=postgresql+psycopg://semanticui:semanticui@localhost:5432/semanticui
# oauth mode only:
# SEMANTICUI_SNOWFLAKE_ACCOUNT=myorg-myaccount
# SEMANTICUI_OAUTH_CLIENT_ID=...
# SEMANTICUI_OAUTH_CLIENT_SECRET=...
# SEMANTICUI_OAUTH_REDIRECT_URI=http://localhost:8000/auth/callback
```

Create venv and install (from `backend/`):

Run: `python -m venv .venv` then activate (`.venv\Scripts\activate` on Windows, `source .venv/bin/activate` otherwise) then `pip install -e ".[dev]"`

- [ ] **Step 2: Write the failing tests**

`backend/tests/test_config.py`:

```python
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
```

`backend/tests/test_app.py`:

```python
from fastapi.testclient import TestClient

from app.errors import ApiError
from app.main import create_app


def test_healthz():
    app = create_app()
    with TestClient(app) as client:
        r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_api_error_rendered_as_envelope():
    app = create_app()

    @app.get("/boom")
    def boom():
        raise ApiError("QUERY_ERROR", 400, "bad query", detail="line 1")

    with TestClient(app) as client:
        r = client.get("/boom")
    assert r.status_code == 400
    assert r.json() == {"code": "QUERY_ERROR", "message": "bad query", "detail": "line 1"}
```

- [ ] **Step 3: Run tests to verify they fail**

Run (from `backend/`): `pytest tests/test_config.py tests/test_app.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app'` (or import errors).

- [ ] **Step 4: Write the implementation**

`backend/app/__init__.py`: empty file.

`backend/app/config.py`:

```python
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
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

`backend/app/errors.py`:

```python
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(self, code: str, status: int, message: str, detail: str | None = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.message = message
        self.detail = detail


class AuthExpiredError(ApiError):
    def __init__(self, message: str = "Sign in required"):
        super().__init__("AUTH_EXPIRED", 401, message)


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    def _handle_api_error(request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content={"code": exc.code, "message": exc.message, "detail": exc.detail},
        )
```

`backend/app/main.py` (lifespan gets the sweeper thread in Task 7; keep a no-op lifespan now):

```python
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.errors import register_error_handlers


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="SemanticUI", lifespan=lifespan)
    register_error_handlers(app)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest tests/test_config.py tests/test_app.py -v`
Expected: 6 PASS.

- [ ] **Step 6: Commit**

```bash
git add .gitignore docker-compose.yml backend
git commit -m "feat: backend scaffold with settings, error envelope, healthz"
```

---

### Task 2: DB models (users, sessions), engine, Alembic migration

**Files:**
- Create: `backend/app/db/__init__.py`, `backend/app/db/base.py`, `backend/app/db/models.py`, `backend/alembic.ini`, `backend/migrations/env.py`, `backend/migrations/script.py.mako`, `backend/migrations/versions/0001_initial.py`, `backend/tests/conftest.py`
- Test: `backend/tests/test_models.py`

**Interfaces:**
- Consumes: `get_settings()` (Task 1).
- Produces: `Base`, `get_engine()`, `get_db()` (FastAPI dependency yielding `sqlalchemy.orm.Session`); models `User(id: UUID, snowflake_account: str, snowflake_user: str, created_at)` with UNIQUE(snowflake_account, snowflake_user) and `DbSession(id: str, user_id: UUID -> users.id, mode: str, access_token_enc: bytes|None, refresh_token_enc: bytes|None, access_expires_at: datetime|None, created_at, last_seen_at)` with `.user` relationship; test fixtures `db_factory` and `db`.

- [ ] **Step 1: Write the failing test**

`backend/tests/conftest.py`:

```python
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base


@pytest.fixture
def db_factory():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False)


@pytest.fixture
def db(db_factory):
    session = db_factory()
    yield session
    session.close()
```

`backend/tests/test_models.py`:

```python
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy.exc import IntegrityError

from app.db.models import DbSession, User


def test_user_identity_is_unique(db):
    db.add(User(snowflake_account="ACME", snowflake_user="ALICE"))
    db.commit()
    db.add(User(snowflake_account="ACME", snowflake_user="ALICE"))
    with pytest.raises(IntegrityError):
        db.commit()


def test_session_links_to_user(db):
    user = User(snowflake_account="ACME", snowflake_user="ALICE")
    db.add(user)
    db.commit()
    sess = DbSession(
        id="sid-1",
        user_id=user.id,
        mode="dev",
        last_seen_at=datetime.now(timezone.utc),
    )
    db.add(sess)
    db.commit()
    loaded = db.get(DbSession, "sid-1")
    assert loaded.user.snowflake_user == "ALICE"
    assert loaded.access_token_enc is None
    assert isinstance(loaded.user.id, uuid.UUID)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_models.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.db'`.

- [ ] **Step 3: Write the implementation**

`backend/app/db/__init__.py`: empty file.

`backend/app/db/base.py`:

```python
from collections.abc import Iterator
from functools import lru_cache

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


@lru_cache
def get_engine():
    return create_engine(get_settings().database_url, pool_pre_ping=True)


def get_db() -> Iterator[Session]:
    factory = sessionmaker(bind=get_engine(), expire_on_commit=False)
    session = factory()
    try:
        yield session
    finally:
        session.close()
```

`backend/app/db/models.py`:

```python
import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, LargeBinary, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("snowflake_account", "snowflake_user", name="uq_users_identity"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    snowflake_account: Mapped[str] = mapped_column(String(255))
    snowflake_user: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class DbSession(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    mode: Mapped[str] = mapped_column(String(8))
    access_token_enc: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    refresh_token_enc: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    access_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

    user: Mapped[User] = relationship()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_models.py -v`
Expected: 2 PASS.

- [ ] **Step 5: Add Alembic (hand-written migration, no autogenerate needed)**

`backend/alembic.ini`:

```ini
[alembic]
script_location = migrations
sqlalchemy.url =

[loggers]
keys = root

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = WARN
handlers = console

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
```

`backend/migrations/env.py`:

```python
from alembic import context
from sqlalchemy import engine_from_config, pool

from app.config import get_settings
from app.db.base import Base
from app.db import models  # noqa: F401  (register tables on Base.metadata)

config = context.config
config.set_main_option("sqlalchemy.url", get_settings().database_url)
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(url=config.get_main_option("sqlalchemy.url"), target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

`backend/migrations/script.py.mako`:

```mako
"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
"""
from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

revision = ${repr(up_revision)}
down_revision = ${repr(down_revision)}
branch_labels = ${repr(branch_labels)}
depends_on = ${repr(depends_on)}


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    ${downgrades if downgrades else "pass"}
```

`backend/migrations/versions/0001_initial.py`:

```python
"""users and sessions

Revision ID: 0001
Revises:
"""
from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("snowflake_account", sa.String(255), nullable=False),
        sa.Column("snowflake_user", sa.String(255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("snowflake_account", "snowflake_user", name="uq_users_identity"),
    )
    op.create_table(
        "sessions",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("mode", sa.String(8), nullable=False),
        sa.Column("access_token_enc", sa.LargeBinary(), nullable=True),
        sa.Column("refresh_token_enc", sa.LargeBinary(), nullable=True),
        sa.Column("access_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("sessions")
    op.drop_table("users")
```

- [ ] **Step 6: Verify the migration applies (needs Docker; skip if unavailable and note it in the commit)**

Run (repo root): `docker compose up -d postgres`
Run (from `backend/`): `alembic upgrade head`
Expected: no errors; `alembic current` shows `0001`.

- [ ] **Step 7: Commit**

```bash
git add backend
git commit -m "feat: users/sessions models with alembic initial migration"
```

---

### Task 3: Token crypto (Fernet)

**Files:**
- Create: `backend/app/auth/__init__.py`, `backend/app/auth/crypto.py`
- Test: `backend/tests/test_crypto.py`

**Interfaces:**
- Consumes: `get_settings().secret_key` (Task 1).
- Produces: `encrypt_token(plain: str) -> bytes`, `decrypt_token(blob: bytes) -> str`, `fernet_from_secret(secret: str) -> Fernet`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_crypto.py`:

```python
import pytest
from cryptography.fernet import InvalidToken

from app.auth.crypto import decrypt_token, encrypt_token, fernet_from_secret


def test_round_trip():
    blob = encrypt_token("my-access-token")
    assert isinstance(blob, bytes)
    assert b"my-access-token" not in blob
    assert decrypt_token(blob) == "my-access-token"


def test_wrong_key_fails():
    blob = fernet_from_secret("key-a").encrypt(b"secret")
    with pytest.raises(InvalidToken):
        fernet_from_secret("key-b").decrypt(blob)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_crypto.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.auth'`.

- [ ] **Step 3: Write the implementation**

`backend/app/auth/__init__.py`: empty file.

`backend/app/auth/crypto.py`:

```python
import base64
import hashlib

from cryptography.fernet import Fernet

from app.config import get_settings


def fernet_from_secret(secret: str) -> Fernet:
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())
    return Fernet(key)


def encrypt_token(plain: str) -> bytes:
    return fernet_from_secret(get_settings().secret_key).encrypt(plain.encode())


def decrypt_token(blob: bytes) -> str:
    return fernet_from_secret(get_settings().secret_key).decrypt(blob).decode()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_crypto.py -v`
Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/auth backend/tests/test_crypto.py
git commit -m "feat: fernet token encryption helpers"
```

---

### Task 4: Session service

**Files:**
- Create: `backend/app/auth/sessions.py`
- Test: `backend/tests/test_sessions.py`

**Interfaces:**
- Consumes: models (Task 2), crypto (Task 3), `get_settings().session_ttl_hours`.
- Produces: `SESSION_COOKIE = "semanticui_session"`; `new_session_id() -> str`; `create_session(db, *, account, user, mode, access_token=None, refresh_token=None, access_expires_at=None) -> DbSession` (upserts the `User` row); `get_active_session(db, session_id) -> DbSession | None` (deletes + returns None when inactive past TTL, else touches `last_seen_at`); `delete_session(db, session_id) -> None`; `set_session_cookie(response, session_id) -> None`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_sessions.py`:

```python
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.auth.crypto import decrypt_token
from app.auth.sessions import (
    create_session,
    delete_session,
    get_active_session,
    new_session_id,
)
from app.db.models import User


def test_session_ids_are_long_random():
    a, b = new_session_id(), new_session_id()
    assert a != b
    assert len(a) >= 40


def test_create_session_upserts_user_and_encrypts_tokens(db):
    s1 = create_session(
        db, account="ACME", user="ALICE", mode="oauth",
        access_token="at-1", refresh_token="rt-1",
        access_expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )
    s2 = create_session(db, account="ACME", user="ALICE", mode="dev")
    users = db.scalars(select(User)).all()
    assert len(users) == 1
    assert s1.user_id == s2.user_id
    assert decrypt_token(s1.access_token_enc) == "at-1"
    assert s2.access_token_enc is None


def test_get_active_session_touches_and_expires(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    before = sess.last_seen_at
    found = get_active_session(db, sess.id)
    assert found is not None and found.last_seen_at >= before

    sess.last_seen_at = datetime.now(timezone.utc) - timedelta(hours=9)
    db.commit()
    assert get_active_session(db, sess.id) is None
    assert get_active_session(db, "nonsense") is None


def test_delete_session(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    delete_session(db, sess.id)
    assert get_active_session(db, sess.id) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_sessions.py -v`
Expected: FAIL with `ImportError` (module `app.auth.sessions` missing).

- [ ] **Step 3: Write the implementation**

`backend/app/auth/sessions.py`:

```python
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.crypto import encrypt_token
from app.config import get_settings
from app.db.models import DbSession, User

SESSION_COOKIE = "semanticui_session"


def new_session_id() -> str:
    return secrets.token_urlsafe(32)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(dt: datetime) -> datetime:
    # SQLite loses tzinfo; treat naive values as UTC.
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def create_session(
    db: Session,
    *,
    account: str,
    user: str,
    mode: str,
    access_token: str | None = None,
    refresh_token: str | None = None,
    access_expires_at: datetime | None = None,
) -> DbSession:
    existing = db.scalar(
        select(User).where(
            User.snowflake_account == account, User.snowflake_user == user
        )
    )
    if existing is None:
        existing = User(snowflake_account=account, snowflake_user=user)
        db.add(existing)
        db.flush()
    sess = DbSession(
        id=new_session_id(),
        user_id=existing.id,
        mode=mode,
        access_token_enc=encrypt_token(access_token) if access_token else None,
        refresh_token_enc=encrypt_token(refresh_token) if refresh_token else None,
        access_expires_at=access_expires_at,
    )
    db.add(sess)
    db.commit()
    db.refresh(sess)
    return sess


def get_active_session(db: Session, session_id: str) -> DbSession | None:
    sess = db.get(DbSession, session_id)
    if sess is None:
        return None
    ttl = timedelta(hours=get_settings().session_ttl_hours)
    if _utcnow() - _as_utc(sess.last_seen_at) > ttl:
        db.delete(sess)
        db.commit()
        return None
    sess.last_seen_at = _utcnow()
    db.commit()
    return sess


def delete_session(db: Session, session_id: str) -> None:
    sess = db.get(DbSession, session_id)
    if sess is not None:
        db.delete(sess)
        db.commit()


def set_session_cookie(response: Response, session_id: str) -> None:
    settings = get_settings()
    response.set_cookie(
        SESSION_COOKIE,
        session_id,
        httponly=True,
        secure=settings.auth_mode != "dev",
        samesite="lax",
        max_age=settings.session_ttl_hours * 3600,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_sessions.py -v`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/auth/sessions.py backend/tests/test_sessions.py
git commit -m "feat: session service with user upsert and inactivity expiry"
```

---

### Task 5: Snowflake OAuth client

**Files:**
- Create: `backend/app/auth/oauth.py`
- Test: `backend/tests/test_oauth.py`

**Interfaces:**
- Consumes: `get_settings()` oauth fields (Task 1).
- Produces: `TokenResponse(access_token: str, refresh_token: str | None, expires_in: int)` dataclass; `class OAuthRefreshError(Exception)`; `class SnowflakeOAuthClient(settings, transport=None)` with `.authorize_url(state) -> str`, `.exchange_code(code) -> TokenResponse`, `.refresh(refresh_token) -> TokenResponse` (raises `OAuthRefreshError` on 4xx); `make_state() -> str` and `consume_state(state) -> bool` (single-use, 10-minute TTL, module-level store); `get_oauth_client() -> SnowflakeOAuthClient`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_oauth.py`:

```python
import json
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app.auth.oauth import (
    OAuthRefreshError,
    SnowflakeOAuthClient,
    consume_state,
    make_state,
)
from app.config import Settings


@pytest.fixture
def settings():
    return Settings(
        _env_file=None,
        auth_mode="oauth",
        snowflake_account="myorg-myaccount",
        oauth_client_id="cid",
        oauth_client_secret="csecret",
    )


def test_authorize_url(settings):
    client = SnowflakeOAuthClient(settings)
    url = urlparse(client.authorize_url("state123"))
    assert url.hostname == "myorg-myaccount.snowflakecomputing.com"
    assert url.path == "/oauth/authorize"
    q = parse_qs(url.query)
    assert q["client_id"] == ["cid"]
    assert q["response_type"] == ["code"]
    assert q["state"] == ["state123"]
    assert q["redirect_uri"] == ["http://localhost:8000/auth/callback"]


def _token_transport(status=200, body=None, capture=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if capture is not None:
            capture.append(request)
        payload = body or {
            "access_token": "at-new",
            "refresh_token": "rt-new",
            "expires_in": 600,
        }
        return httpx.Response(status, json=payload)

    return httpx.MockTransport(handler)


def test_exchange_code_posts_form_with_basic_auth(settings):
    seen: list[httpx.Request] = []
    client = SnowflakeOAuthClient(settings, transport=_token_transport(capture=seen))
    tok = client.exchange_code("the-code")
    assert tok.access_token == "at-new"
    assert tok.refresh_token == "rt-new"
    assert tok.expires_in == 600
    req = seen[0]
    assert req.url.path == "/oauth/token-request"
    assert req.headers["authorization"].startswith("Basic ")
    form = parse_qs(req.content.decode())
    assert form["grant_type"] == ["authorization_code"]
    assert form["code"] == ["the-code"]


def test_refresh_raises_on_4xx(settings):
    client = SnowflakeOAuthClient(
        settings, transport=_token_transport(status=400, body={"error": "invalid_grant"})
    )
    with pytest.raises(OAuthRefreshError):
        client.refresh("rt-old")


def test_state_is_single_use():
    s = make_state()
    assert consume_state(s) is True
    assert consume_state(s) is False
    assert consume_state("unknown") is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_oauth.py -v`
Expected: FAIL with `ImportError` (module `app.auth.oauth` missing).

- [ ] **Step 3: Write the implementation**

`backend/app/auth/oauth.py`:

```python
import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx

from app.config import Settings, get_settings

_STATE_TTL_SECONDS = 600
_states: dict[str, float] = {}


@dataclass
class TokenResponse:
    access_token: str
    refresh_token: str | None
    expires_in: int


class OAuthRefreshError(Exception):
    pass


def make_state() -> str:
    state = secrets.token_urlsafe(16)
    _states[state] = time.monotonic()
    return state


def consume_state(state: str) -> bool:
    created = _states.pop(state, None)
    return created is not None and (time.monotonic() - created) < _STATE_TTL_SECONDS


class SnowflakeOAuthClient:
    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None):
        self._settings = settings
        self._transport = transport

    @property
    def base_url(self) -> str:
        return f"https://{self._settings.snowflake_account}.snowflakecomputing.com"

    def authorize_url(self, state: str) -> str:
        query = urlencode(
            {
                "client_id": self._settings.oauth_client_id,
                "response_type": "code",
                "redirect_uri": self._settings.oauth_redirect_uri,
                "state": state,
            }
        )
        return f"{self.base_url}/oauth/authorize?{query}"

    def _token_request(self, data: dict) -> TokenResponse:
        with httpx.Client(transport=self._transport, timeout=30) as client:
            resp = client.post(
                f"{self.base_url}/oauth/token-request",
                data=data,
                auth=(self._settings.oauth_client_id, self._settings.oauth_client_secret),
            )
        if resp.status_code >= 400:
            raise OAuthRefreshError(f"token endpoint returned {resp.status_code}")
        body = resp.json()
        return TokenResponse(
            access_token=body["access_token"],
            refresh_token=body.get("refresh_token"),
            expires_in=int(body.get("expires_in", 600)),
        )

    def exchange_code(self, code: str) -> TokenResponse:
        return self._token_request(
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self._settings.oauth_redirect_uri,
            }
        )

    def refresh(self, refresh_token: str) -> TokenResponse:
        return self._token_request(
            {"grant_type": "refresh_token", "refresh_token": refresh_token}
        )


def get_oauth_client() -> SnowflakeOAuthClient:
    return SnowflakeOAuthClient(get_settings())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_oauth.py -v`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/auth/oauth.py backend/tests/test_oauth.py
git commit -m "feat: snowflake oauth client with state store and refresh"
```

---

### Task 6: Snowflake connect + identity probe

**Files:**
- Create: `backend/app/snowflake/__init__.py`, `backend/app/snowflake/connect.py`
- Test: `backend/tests/test_connect.py`

**Interfaces:**
- Consumes: `get_settings()`.
- Produces: `connect_oauth(token: str)` and `connect_dev(*, account: str, user: str, authenticator: str, password: str | None = None)` -> live Snowflake connection (both set `session_parameters={"STATEMENT_TIMEOUT_IN_SECONDS": ...}`); `probe_identity(conn) -> tuple[str, str]` returning `(CURRENT_ACCOUNT(), CURRENT_USER())`. Later tasks patch `connect_oauth` / `connect_dev` via `monkeypatch.setattr(sf_connect, ...)`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_connect.py`:

```python
import snowflake.connector

from app.snowflake import connect as sf_connect


def test_connect_oauth_passes_token_and_timeout(monkeypatch):
    seen = {}

    def fake_connect(**kwargs):
        seen.update(kwargs)
        return "CONN"

    monkeypatch.setenv("SEMANTICUI_SNOWFLAKE_ACCOUNT", "myorg-myaccount")
    from app.config import get_settings
    get_settings.cache_clear()
    monkeypatch.setattr(snowflake.connector, "connect", fake_connect)
    conn = sf_connect.connect_oauth("tok-123")
    get_settings.cache_clear()

    assert conn == "CONN"
    assert seen["account"] == "myorg-myaccount"
    assert seen["authenticator"] == "oauth"
    assert seen["token"] == "tok-123"
    assert seen["session_parameters"]["STATEMENT_TIMEOUT_IN_SECONDS"] == 60


def test_connect_dev_externalbrowser_and_password(monkeypatch):
    calls = []

    def fake_connect(**kwargs):
        calls.append(kwargs)
        return "CONN"

    monkeypatch.setattr(snowflake.connector, "connect", fake_connect)
    sf_connect.connect_dev(account="acct", user="alice", authenticator="externalbrowser")
    sf_connect.connect_dev(
        account="acct", user="alice", authenticator="password", password="pw"
    )
    assert calls[0]["authenticator"] == "externalbrowser"
    assert "password" not in calls[0]
    assert calls[1]["password"] == "pw"
    assert "authenticator" not in calls[1]


class FakeIdentityCursor:
    def execute(self, sql):
        assert "CURRENT_ACCOUNT()" in sql and "CURRENT_USER()" in sql
        return self

    def fetchone(self):
        return ("ACME", "ALICE")

    def close(self):
        pass


class FakeIdentityConn:
    def cursor(self):
        return FakeIdentityCursor()


def test_probe_identity():
    assert sf_connect.probe_identity(FakeIdentityConn()) == ("ACME", "ALICE")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_connect.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.snowflake'`.

- [ ] **Step 3: Write the implementation**

`backend/app/snowflake/__init__.py`: empty file.

`backend/app/snowflake/connect.py`:

```python
from typing import Any

import snowflake.connector

from app.config import get_settings


def _session_parameters() -> dict:
    return {"STATEMENT_TIMEOUT_IN_SECONDS": get_settings().statement_timeout_seconds}


def connect_oauth(token: str) -> Any:
    settings = get_settings()
    return snowflake.connector.connect(
        account=settings.snowflake_account,
        authenticator="oauth",
        token=token,
        session_parameters=_session_parameters(),
    )


def connect_dev(
    *, account: str, user: str, authenticator: str, password: str | None = None
) -> Any:
    kwargs: dict[str, Any] = {
        "account": account,
        "user": user,
        "session_parameters": _session_parameters(),
    }
    if authenticator == "password":
        kwargs["password"] = password
    else:
        kwargs["authenticator"] = "externalbrowser"
    return snowflake.connector.connect(**kwargs)


def probe_identity(conn: Any) -> tuple[str, str]:
    cur = conn.cursor()
    try:
        row = cur.execute("SELECT CURRENT_ACCOUNT(), CURRENT_USER()").fetchone()
        return str(row[0]), str(row[1])
    finally:
        cur.close()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_connect.py -v`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/snowflake backend/tests/test_connect.py
git commit -m "feat: snowflake connect helpers and identity probe"
```

---

### Task 7: Connection cache (ConnectionProvider) + sweeper

**Files:**
- Create: `backend/app/snowflake/provider.py`, `backend/tests/fakes.py`
- Modify: `backend/app/main.py` (lifespan starts sweeper thread)
- Test: `backend/tests/test_provider.py`

**Interfaces:**
- Consumes: crypto (Task 3), sessions model (Task 2), `oauth` module (Task 5, patched as `oauth_mod`), `connect` module (Task 6, patched as `sf_connect`), `AuthExpiredError` (Task 1).
- Produces: `CacheEntry(conn, last_used: float, lock: threading.Lock)`; `ConnectionCache(idle_ttl: float, max_size: int, clock=time.monotonic)` with `.put(session_id, conn)`, `.acquire(db, sess: DbSession) -> CacheEntry`, `.evict(session_id)`, `.sweep() -> int`; module functions `get_cache() -> ConnectionCache` and `reset_cache()`. Test helpers `FakeCursor`, `FakeConnection`, `FakeCol` in `tests/fakes.py` (reused by Tasks 10-12).

- [ ] **Step 1: Write the test fakes**

`backend/tests/fakes.py`:

```python
from dataclasses import dataclass, field
from typing import Any


@dataclass
class FakeCol:
    name: str
    type_code: int = 2


@dataclass
class FakeCursor:
    rows: list[tuple] = field(default_factory=list)
    description: list[FakeCol] = field(default_factory=list)
    sfqid: str = "q-1"
    error: Exception | None = None
    executed: list[str] = field(default_factory=list)

    def execute(self, sql: str) -> "FakeCursor":
        self.executed.append(sql)
        if self.error is not None:
            raise self.error
        return self

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchmany(self, n: int):
        return self.rows[:n]

    def fetchall(self):
        return list(self.rows)

    def close(self) -> None:
        pass


class FakeConnection:
    def __init__(self, cursor: FakeCursor | None = None):
        self._cursor = cursor or FakeCursor()
        self.closed = False

    def cursor(self) -> FakeCursor:
        return self._cursor

    def is_closed(self) -> bool:
        return self.closed

    def close(self) -> None:
        self.closed = True
```

- [ ] **Step 2: Write the failing test**

`backend/tests/test_provider.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest

from app.auth import oauth as oauth_mod
from app.auth.crypto import decrypt_token
from app.auth.oauth import OAuthRefreshError, TokenResponse
from app.auth.sessions import create_session
from app.errors import AuthExpiredError
from app.snowflake import connect as sf_connect
from app.snowflake.provider import ConnectionCache
from tests.fakes import FakeConnection


def make_cache(clock=None, max_size=10):
    kwargs = {"idle_ttl": 900, "max_size": max_size}
    if clock is not None:
        kwargs["clock"] = clock
    return ConnectionCache(**kwargs)


def test_dev_put_then_acquire_roundtrip(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    cache = make_cache()
    conn = FakeConnection()
    cache.put(sess.id, conn)
    entry = cache.acquire(db, sess)
    assert entry.conn is conn


def test_dev_missing_or_dead_connection_raises(db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    cache = make_cache()
    with pytest.raises(AuthExpiredError):
        cache.acquire(db, sess)
    dead = FakeConnection()
    dead.closed = True
    cache.put(sess.id, dead)
    with pytest.raises(AuthExpiredError):
        cache.acquire(db, sess)


def test_oauth_builds_once_and_reuses(db, monkeypatch):
    sess = create_session(
        db, account="ACME", user="ALICE", mode="oauth",
        access_token="at-1", refresh_token="rt-1",
        access_expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )
    calls = []
    monkeypatch.setattr(
        sf_connect, "connect_oauth", lambda token: calls.append(token) or FakeConnection()
    )
    cache = make_cache()
    e1 = cache.acquire(db, sess)
    e2 = cache.acquire(db, sess)
    assert e1.conn is e2.conn
    assert calls == ["at-1"]


def test_oauth_refreshes_expired_token(db, monkeypatch):
    sess = create_session(
        db, account="ACME", user="ALICE", mode="oauth",
        access_token="at-old", refresh_token="rt-old",
        access_expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
    )

    class StubOAuth:
        def refresh(self, refresh_token):
            assert refresh_token == "rt-old"
            return TokenResponse("at-new", "rt-new", 600)

    monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
    used = []
    monkeypatch.setattr(
        sf_connect, "connect_oauth", lambda token: used.append(token) or FakeConnection()
    )
    cache = make_cache()
    cache.acquire(db, sess)
    assert used == ["at-new"]
    assert decrypt_token(sess.access_token_enc) == "at-new"
    assert decrypt_token(sess.refresh_token_enc) == "rt-new"


def test_oauth_refresh_failure_is_auth_expired(db, monkeypatch):
    sess = create_session(
        db, account="ACME", user="ALICE", mode="oauth",
        access_token="at-old", refresh_token="rt-old",
        access_expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
    )

    class StubOAuth:
        def refresh(self, refresh_token):
            raise OAuthRefreshError("invalid_grant")

    monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
    with pytest.raises(AuthExpiredError):
        make_cache().acquire(db, sess)


def test_sweep_closes_idle_connections(db):
    now = [1000.0]
    cache = make_cache(clock=lambda: now[0])
    conn = FakeConnection()
    cache.put("sid-1", conn)
    assert cache.sweep() == 0
    now[0] += 901
    assert cache.sweep() == 1
    assert conn.closed is True


def test_lru_eviction_at_max_size(db):
    cache = make_cache(max_size=1)
    first, second = FakeConnection(), FakeConnection()
    cache.put("sid-1", first)
    cache.put("sid-2", second)
    assert first.closed is True
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/test_provider.py -v`
Expected: FAIL with `ImportError` (module `app.snowflake.provider` missing).

- [ ] **Step 4: Write the implementation**

`backend/app/snowflake/provider.py`:

```python
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy.orm import Session

from app.auth import oauth as oauth_mod
from app.auth.crypto import decrypt_token, encrypt_token
from app.auth.oauth import OAuthRefreshError
from app.config import get_settings
from app.db.models import DbSession
from app.errors import AuthExpiredError
from app.snowflake import connect as sf_connect

_REFRESH_SKEW = timedelta(seconds=30)


@dataclass
class CacheEntry:
    conn: Any
    last_used: float
    lock: threading.Lock = field(default_factory=threading.Lock)


def _is_alive(conn: Any) -> bool:
    try:
        return not conn.is_closed()
    except Exception:
        return False


def _close_quietly(conn: Any) -> None:
    try:
        conn.close()
    except Exception:
        pass


class ConnectionCache:
    def __init__(
        self,
        *,
        idle_ttl: float,
        max_size: int,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._idle_ttl = idle_ttl
        self._max_size = max_size
        self._clock = clock
        self._entries: dict[str, CacheEntry] = {}
        self._lock = threading.Lock()

    def put(self, session_id: str, conn: Any) -> None:
        with self._lock:
            old = self._entries.pop(session_id, None)
            if old is not None:
                _close_quietly(old.conn)
            self._entries[session_id] = CacheEntry(conn=conn, last_used=self._clock())
            self._enforce_cap()

    def _enforce_cap(self) -> None:
        while len(self._entries) > self._max_size:
            oldest_id = min(self._entries, key=lambda k: self._entries[k].last_used)
            _close_quietly(self._entries.pop(oldest_id).conn)

    def acquire(self, db: Session, sess: DbSession) -> CacheEntry:
        with self._lock:
            entry = self._entries.get(sess.id)
            if entry is not None and _is_alive(entry.conn):
                entry.last_used = self._clock()
                return entry
            if entry is not None:
                _close_quietly(self._entries.pop(sess.id).conn)
        if sess.mode != "oauth":
            raise AuthExpiredError("Dev session connection lost; sign in again")
        conn = self._build_oauth(db, sess)
        with self._lock:
            self._entries[sess.id] = CacheEntry(conn=conn, last_used=self._clock())
            self._enforce_cap()
            return self._entries[sess.id]

    def _build_oauth(self, db: Session, sess: DbSession) -> Any:
        token = decrypt_token(sess.access_token_enc)
        expires_at = sess.access_expires_at
        if expires_at is not None and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        if expires_at is None or expires_at <= now + _REFRESH_SKEW:
            if sess.refresh_token_enc is None:
                raise AuthExpiredError()
            try:
                tok = oauth_mod.get_oauth_client().refresh(
                    decrypt_token(sess.refresh_token_enc)
                )
            except OAuthRefreshError as exc:
                raise AuthExpiredError() from exc
            token = tok.access_token
            sess.access_token_enc = encrypt_token(tok.access_token)
            if tok.refresh_token:
                sess.refresh_token_enc = encrypt_token(tok.refresh_token)
            sess.access_expires_at = now + timedelta(seconds=tok.expires_in)
            db.commit()
        return sf_connect.connect_oauth(token)

    def evict(self, session_id: str) -> None:
        with self._lock:
            entry = self._entries.pop(session_id, None)
        if entry is not None:
            _close_quietly(entry.conn)

    def sweep(self) -> int:
        cutoff = self._clock() - self._idle_ttl
        closed = 0
        with self._lock:
            for sid in [s for s, e in self._entries.items() if e.last_used < cutoff]:
                _close_quietly(self._entries.pop(sid).conn)
                closed += 1
        return closed


_cache: ConnectionCache | None = None


def get_cache() -> ConnectionCache:
    global _cache
    if _cache is None:
        settings = get_settings()
        _cache = ConnectionCache(
            idle_ttl=settings.connection_idle_ttl_seconds,
            max_size=settings.connection_cache_max,
        )
    return _cache


def reset_cache() -> None:
    global _cache
    if _cache is not None:
        for sid in list(_cache._entries):
            _cache.evict(sid)
    _cache = None
```

Update `backend/app/main.py` to start the sweeper in the lifespan (replace the whole file):

```python
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.errors import register_error_handlers
from app.snowflake.provider import get_cache


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop = threading.Event()

    def _sweep_loop() -> None:
        while not stop.wait(60):
            try:
                get_cache().sweep()
            except Exception:
                pass

    thread = threading.Thread(target=_sweep_loop, daemon=True)
    thread.start()
    yield
    stop.set()


def create_app() -> FastAPI:
    app = FastAPI(title="SemanticUI", lifespan=lifespan)
    register_error_handlers(app)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
```

- [ ] **Step 5: Run ALL tests to verify they pass**

Run: `pytest -v`
Expected: all tests pass (provider tests plus everything from Tasks 1-6).

- [ ] **Step 6: Commit**

```bash
git add backend/app/snowflake/provider.py backend/app/main.py backend/tests/fakes.py backend/tests/test_provider.py
git commit -m "feat: per-user connection cache with oauth rebuild, ttl sweep, lru cap"
```

---

### Task 8: Auth routes (OAuth flow, logout, config, me) + current_session

**Files:**
- Create: `backend/app/auth/routes.py`
- Modify: `backend/app/main.py` (include router), `backend/tests/conftest.py` (add `make_client`/`client` fixtures)
- Test: `backend/tests/test_auth_routes.py`

**Interfaces:**
- Consumes: sessions service (Task 4), oauth module (Task 5), connect module (Task 6), provider (Task 7).
- Produces: dependency `current_session(request, db=Depends(get_db)) -> DbSession` (raises `AuthExpiredError`); routes `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`, `GET /api/config -> {"authMode"}`, `GET /api/me -> {"snowflakeUser","snowflakeAccount","mode"}`; conftest fixtures `make_client(**env) -> TestClient` and `client` (dev-mode TestClient with `get_db` overridden).

Note on the spec's "best-effort token revocation": Snowflake built-in OAuth has no client-callable revocation endpoint, so logout's revocation is deleting the session row (destroying our only copy of the encrypted tokens) and closing the cached connection; the access token then dies on its own <=10-minute expiry. No further action needed.

- [ ] **Step 1: Extend conftest with app client fixtures**

Append to `backend/tests/conftest.py`:

```python
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db.base import get_db
from app.main import create_app
from app.snowflake import provider


@pytest.fixture
def make_client(db_factory, monkeypatch):
    def _make(**env) -> TestClient:
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        get_settings.cache_clear()
        provider.reset_cache()
        app = create_app()

        def override():
            session = db_factory()
            try:
                yield session
            finally:
                session.close()

        app.dependency_overrides[get_db] = override
        return TestClient(app)

    yield _make
    get_settings.cache_clear()
    provider.reset_cache()


@pytest.fixture
def client(make_client):
    return make_client(SEMANTICUI_AUTH_MODE="dev")
```

- [ ] **Step 2: Write the failing test**

`backend/tests/test_auth_routes.py`:

```python
from urllib.parse import parse_qs, urlparse

from app.auth import oauth as oauth_mod
from app.auth.oauth import TokenResponse
from app.auth.sessions import SESSION_COOKIE, create_session
from app.snowflake import connect as sf_connect
from app.snowflake.provider import get_cache
from tests.fakes import FakeConnection

OAUTH_ENV = {
    "SEMANTICUI_AUTH_MODE": "oauth",
    "SEMANTICUI_SNOWFLAKE_ACCOUNT": "myorg-myaccount",
    "SEMANTICUI_OAUTH_CLIENT_ID": "cid",
    "SEMANTICUI_OAUTH_CLIENT_SECRET": "csecret",
}


def test_config_reports_auth_mode(client):
    r = client.get("/api/config")
    assert r.status_code == 200
    assert r.json() == {"authMode": "dev"}


def test_me_without_cookie_is_401(client):
    r = client.get("/api/me")
    assert r.status_code == 401
    assert r.json()["code"] == "AUTH_EXPIRED"


def test_me_with_session(client, db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    client.cookies.set(SESSION_COOKIE, sess.id)
    r = client.get("/api/me")
    assert r.status_code == 200
    assert r.json() == {
        "snowflakeUser": "ALICE", "snowflakeAccount": "ACME", "mode": "dev"
    }


def test_oauth_login_disabled_in_dev_mode(client):
    r = client.get("/auth/login", follow_redirects=False)
    assert r.status_code == 400
    assert r.json()["code"] == "AUTH_FAILED"


def test_oauth_login_redirects_to_snowflake(make_client):
    client = make_client(**OAUTH_ENV)
    r = client.get("/auth/login", follow_redirects=False)
    assert r.status_code == 307
    url = urlparse(r.headers["location"])
    assert url.hostname == "myorg-myaccount.snowflakecomputing.com"
    assert parse_qs(url.query)["client_id"] == ["cid"]


def test_oauth_callback_creates_session_and_caches_conn(make_client, db, monkeypatch):
    client = make_client(**OAUTH_ENV)

    class StubOAuth:
        def exchange_code(self, code):
            assert code == "the-code"
            return TokenResponse("at-1", "rt-1", 600)

    conn = FakeConnection()
    monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
    monkeypatch.setattr(oauth_mod, "consume_state", lambda s: s == "good-state")
    monkeypatch.setattr(sf_connect, "connect_oauth", lambda token: conn)
    monkeypatch.setattr(sf_connect, "probe_identity", lambda c: ("ACME", "ALICE"))

    r = client.get(
        "/auth/callback",
        params={"code": "the-code", "state": "good-state"},
        follow_redirects=False,
    )
    assert r.status_code == 303
    assert r.headers["location"] == "/"
    sid = client.cookies.get(SESSION_COOKIE)
    assert sid
    from app.auth.sessions import get_active_session
    sess = get_active_session(db, sid)
    assert sess is not None and sess.mode == "oauth"
    assert get_cache().acquire(db, sess).conn is conn


def test_oauth_callback_rejects_bad_state(make_client, monkeypatch):
    client = make_client(**OAUTH_ENV)
    monkeypatch.setattr(oauth_mod, "consume_state", lambda s: False)
    r = client.get(
        "/auth/callback", params={"code": "c", "state": "bad"}, follow_redirects=False
    )
    assert r.status_code == 401
    assert r.json()["code"] == "AUTH_FAILED"


def test_logout_destroys_session(client, db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    get_cache().put(sess.id, FakeConnection())
    client.cookies.set(SESSION_COOKIE, sess.id)
    r = client.post("/auth/logout")
    assert r.status_code == 200
    from app.auth.sessions import get_active_session
    assert get_active_session(db, sess.id) is None
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/test_auth_routes.py -v`
Expected: FAIL — 404s and `ImportError` for `app.auth.routes` (routes not registered yet).

- [ ] **Step 4: Write the implementation**

`backend/app/auth/routes.py`:

```python
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy.orm import Session

from app.auth import oauth as oauth_mod
from app.auth.oauth import OAuthRefreshError
from app.auth.sessions import (
    SESSION_COOKIE,
    create_session,
    delete_session,
    get_active_session,
    set_session_cookie,
)
from app.config import get_settings
from app.db.base import get_db
from app.db.models import DbSession
from app.errors import ApiError, AuthExpiredError
from app.snowflake import connect as sf_connect
from app.snowflake.provider import get_cache

router = APIRouter()


def current_session(request: Request, db: Session = Depends(get_db)) -> DbSession:
    sid = request.cookies.get(SESSION_COOKIE)
    sess = get_active_session(db, sid) if sid else None
    if sess is None:
        raise AuthExpiredError()
    return sess


@router.get("/auth/login")
def oauth_login() -> RedirectResponse:
    if get_settings().auth_mode != "oauth":
        raise ApiError("AUTH_FAILED", 400, "OAuth login is not available in dev mode")
    client = oauth_mod.get_oauth_client()
    return RedirectResponse(client.authorize_url(oauth_mod.make_state()))


@router.get("/auth/callback")
def oauth_callback(
    code: str, state: str, db: Session = Depends(get_db)
) -> RedirectResponse:
    if get_settings().auth_mode != "oauth":
        raise ApiError("AUTH_FAILED", 400, "OAuth login is not available in dev mode")
    if not oauth_mod.consume_state(state):
        raise ApiError("AUTH_FAILED", 401, "Invalid or expired OAuth state")
    try:
        tok = oauth_mod.get_oauth_client().exchange_code(code)
    except OAuthRefreshError:
        raise ApiError("AUTH_FAILED", 401, "OAuth code exchange failed")
    conn = sf_connect.connect_oauth(tok.access_token)
    account, user = sf_connect.probe_identity(conn)
    sess = create_session(
        db,
        account=account,
        user=user,
        mode="oauth",
        access_token=tok.access_token,
        refresh_token=tok.refresh_token,
        access_expires_at=datetime.now(timezone.utc) + timedelta(seconds=tok.expires_in),
    )
    get_cache().put(sess.id, conn)
    response = RedirectResponse("/", status_code=303)
    set_session_cookie(response, sess.id)
    return response


@router.post("/auth/logout")
def logout(request: Request, db: Session = Depends(get_db)) -> JSONResponse:
    sid = request.cookies.get(SESSION_COOKIE)
    if sid:
        get_cache().evict(sid)
        delete_session(db, sid)
    response = JSONResponse({"ok": True})
    response.delete_cookie(SESSION_COOKIE)
    return response


@router.get("/api/config")
def config() -> dict:
    return {"authMode": get_settings().auth_mode}


@router.get("/api/me")
def me(sess: DbSession = Depends(current_session)) -> dict:
    return {
        "snowflakeUser": sess.user.snowflake_user,
        "snowflakeAccount": sess.user.snowflake_account,
        "mode": sess.mode,
    }
```

In `backend/app/main.py`, inside `create_app()` after `register_error_handlers(app)`, add:

```python
    from app.auth.routes import router as auth_router

    app.include_router(auth_router)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/test_auth_routes.py -v`
Expected: 8 PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/app/auth/routes.py backend/app/main.py backend/tests/conftest.py backend/tests/test_auth_routes.py
git commit -m "feat: oauth login/callback/logout routes with session dependency"
```

---

### Task 9: Dev login route

**Files:**
- Create: `backend/app/auth/dev.py`
- Modify: `backend/app/main.py` (include router)
- Test: `backend/tests/test_dev_login.py`

**Interfaces:**
- Consumes: sessions (Task 4), connect module (Task 6), provider (Task 7), `make_client` fixture (Task 8).
- Produces: `POST /auth/dev-login` accepting `{"account","user","authenticator":"externalbrowser"|"password","password"?}`, returning the same body as `/api/me` and setting the session cookie. Returns 400 `AUTH_FAILED` when `auth_mode != "dev"`, 401 `AUTH_FAILED` when the Snowflake connect fails.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_dev_login.py`:

```python
from app.snowflake import connect as sf_connect
from app.auth.sessions import SESSION_COOKIE
from tests.fakes import FakeConnection


def test_dev_login_happy_path(client, monkeypatch):
    conn = FakeConnection()
    seen = {}

    def fake_connect_dev(**kwargs):
        seen.update(kwargs)
        return conn

    monkeypatch.setattr(sf_connect, "connect_dev", fake_connect_dev)
    monkeypatch.setattr(sf_connect, "probe_identity", lambda c: ("ACME", "ALICE"))
    r = client.post(
        "/auth/dev-login",
        json={"account": "acct", "user": "alice", "authenticator": "externalbrowser"},
    )
    assert r.status_code == 200
    assert r.json() == {
        "snowflakeUser": "ALICE", "snowflakeAccount": "ACME", "mode": "dev"
    }
    assert seen["authenticator"] == "externalbrowser"
    assert client.cookies.get(SESSION_COOKIE)
    me = client.get("/api/me")
    assert me.status_code == 200


def test_dev_login_failure_is_auth_failed(client, monkeypatch):
    def boom(**kwargs):
        raise RuntimeError("250001: could not connect")

    monkeypatch.setattr(sf_connect, "connect_dev", boom)
    r = client.post(
        "/auth/dev-login",
        json={"account": "acct", "user": "alice", "authenticator": "password",
              "password": "wrong"},
    )
    assert r.status_code == 401
    assert r.json()["code"] == "AUTH_FAILED"


def test_dev_login_disabled_in_oauth_mode(make_client):
    client = make_client(
        SEMANTICUI_AUTH_MODE="oauth",
        SEMANTICUI_SNOWFLAKE_ACCOUNT="myorg-myaccount",
        SEMANTICUI_OAUTH_CLIENT_ID="cid",
        SEMANTICUI_OAUTH_CLIENT_SECRET="csecret",
    )
    r = client.post(
        "/auth/dev-login",
        json={"account": "acct", "user": "alice", "authenticator": "externalbrowser"},
    )
    assert r.status_code == 400
    assert r.json()["code"] == "AUTH_FAILED"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_dev_login.py -v`
Expected: FAIL with 404 (route missing).

- [ ] **Step 3: Write the implementation**

`backend/app/auth/dev.py`:

```python
from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.sessions import create_session, set_session_cookie
from app.config import get_settings
from app.db.base import get_db
from app.errors import ApiError
from app.snowflake import connect as sf_connect
from app.snowflake.provider import get_cache

router = APIRouter()


class DevLoginRequest(BaseModel):
    account: str
    user: str
    authenticator: Literal["externalbrowser", "password"] = "externalbrowser"
    password: str | None = None


@router.post("/auth/dev-login")
def dev_login(req: DevLoginRequest, db: Session = Depends(get_db)) -> JSONResponse:
    if get_settings().auth_mode != "dev":
        raise ApiError("AUTH_FAILED", 400, "Dev login is disabled in oauth mode")
    try:
        conn = sf_connect.connect_dev(
            account=req.account,
            user=req.user,
            authenticator=req.authenticator,
            password=req.password,
        )
    except Exception as exc:
        raise ApiError("AUTH_FAILED", 401, "Snowflake login failed", detail=str(exc))
    account, user = sf_connect.probe_identity(conn)
    sess = create_session(db, account=account, user=user, mode="dev")
    get_cache().put(sess.id, conn)
    response = JSONResponse(
        {"snowflakeUser": user, "snowflakeAccount": account, "mode": "dev"}
    )
    set_session_cookie(response, sess.id)
    return response
```

In `backend/app/main.py`, next to the auth router include, add:

```python
    from app.auth.dev import router as dev_router

    app.include_router(dev_router)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_dev_login.py -v`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/auth/dev.py backend/app/main.py backend/tests/test_dev_login.py
git commit -m "feat: dev-mode login via externalbrowser or password"
```

---

### Task 10: Query gateway + Snowflake error mapping

**Files:**
- Create: `backend/app/snowflake/gateway.py`
- Test: `backend/tests/test_gateway.py`

**Interfaces:**
- Consumes: `ApiError` (Task 1), fakes (Task 7).
- Produces: `QueryResult(columns: list[dict], rows: list[list], truncated: bool, sfqid: str | None)` where each column is `{"name": str, "type": str}`; `run_query(conn, sql: str, *, max_rows: int) -> QueryResult` (fetches `max_rows + 1` to detect truncation); `map_snowflake_error(exc: Exception) -> ApiError`.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_gateway.py`:

```python
import pytest
from snowflake.connector.errors import ProgrammingError

from app.errors import ApiError
from app.snowflake.gateway import map_snowflake_error, run_query
from tests.fakes import FakeCol, FakeConnection, FakeCursor


def test_run_query_shapes_result():
    cur = FakeCursor(
        rows=[("2026-01-01", 10), ("2026-01-02", 20)],
        description=[FakeCol("ORDER_DATE", 3), FakeCol("TOTAL_REVENUE", 0)],
        sfqid="abc-123",
    )
    result = run_query(FakeConnection(cur), "SELECT 1", max_rows=100)
    assert [c["name"] for c in result.columns] == ["ORDER_DATE", "TOTAL_REVENUE"]
    assert all(isinstance(c["type"], str) for c in result.columns)
    assert result.rows == [["2026-01-01", 10], ["2026-01-02", 20]]
    assert result.truncated is False
    assert result.sfqid == "abc-123"


def test_run_query_truncates_at_max_rows():
    cur = FakeCursor(rows=[(i,) for i in range(5)], description=[FakeCol("N")])
    result = run_query(FakeConnection(cur), "SELECT 1", max_rows=3)
    assert len(result.rows) == 3
    assert result.truncated is True


def test_run_query_maps_errors():
    cur = FakeCursor(error=ProgrammingError(msg="Syntax error near X", errno=1003))
    with pytest.raises(ApiError) as exc_info:
        run_query(FakeConnection(cur), "SELECT nonsense", max_rows=10)
    assert exc_info.value.code == "QUERY_ERROR"
    assert exc_info.value.status == 400
    assert "Syntax error" in exc_info.value.message


def test_map_insufficient_privileges_is_403():
    err = map_snowflake_error(
        ProgrammingError(msg="Insufficient privileges to operate on view", errno=3001)
    )
    assert err.code == "SNOWFLAKE_FORBIDDEN"
    assert err.status == 403


def test_map_timeout_is_504():
    err = map_snowflake_error(
        ProgrammingError(msg="Statement reached its statement or warehouse timeout", errno=630)
    )
    assert err.code == "TIMEOUT"
    assert err.status == 504


def test_map_unknown_exception_is_query_error():
    err = map_snowflake_error(RuntimeError("boom"))
    assert err.code == "QUERY_ERROR"
    assert err.status == 400
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_gateway.py -v`
Expected: FAIL with `ImportError` (module `app.snowflake.gateway` missing).

- [ ] **Step 3: Write the implementation**

`backend/app/snowflake/gateway.py`:

```python
from dataclasses import dataclass
from typing import Any

from snowflake.connector.constants import FIELD_ID_TO_NAME
from snowflake.connector.errors import Error as SnowflakeError

from app.errors import ApiError


@dataclass
class QueryResult:
    columns: list[dict]
    rows: list[list]
    truncated: bool
    sfqid: str | None


def map_snowflake_error(exc: Exception) -> ApiError:
    if isinstance(exc, SnowflakeError):
        errno = getattr(exc, "errno", None)
        message = getattr(exc, "raw_msg", None) or getattr(exc, "msg", None) or str(exc)
        if errno == 3001 or "insufficient privileges" in message.lower():
            return ApiError("SNOWFLAKE_FORBIDDEN", 403, message)
        if errno in (604, 630) or "timeout" in message.lower():
            return ApiError("TIMEOUT", 504, message)
        return ApiError("QUERY_ERROR", 400, message)
    return ApiError("QUERY_ERROR", 400, str(exc))


def _type_name(type_code: Any) -> str:
    try:
        return FIELD_ID_TO_NAME[type_code]
    except Exception:
        return str(type_code)


def run_query(conn: Any, sql: str, *, max_rows: int) -> QueryResult:
    cur = conn.cursor()
    try:
        try:
            cur.execute(sql)
        except Exception as exc:
            raise map_snowflake_error(exc) from exc
        raw = cur.fetchmany(max_rows + 1)
        truncated = len(raw) > max_rows
        columns = [
            {"name": d.name, "type": _type_name(d.type_code)}
            for d in (cur.description or [])
        ]
        return QueryResult(
            columns=columns,
            rows=[list(r) for r in raw[:max_rows]],
            truncated=truncated,
            sfqid=getattr(cur, "sfqid", None),
        )
    finally:
        cur.close()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_gateway.py -v`
Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/snowflake/gateway.py backend/tests/test_gateway.py
git commit -m "feat: query gateway with row cap and snowflake error mapping"
```

---

### Task 11: Semantic view discovery (SHOW / DESCRIBE + parser)

**Files:**
- Create: `backend/app/semantic/__init__.py`, `backend/app/semantic/discovery.py`
- Test: `backend/tests/test_discovery.py`

**Interfaces:**
- Consumes: `map_snowflake_error` (Task 10), `ApiError` (Task 1), fakes (Task 7).
- Produces: `quote_ident(name: str) -> str` (raises `ApiError("QUERY_ERROR", 400, ...)` if the name contains `"`); `list_semantic_views(conn, database=None, schema=None) -> list[dict]` with items `{"name","database","schema","comment"}`; `describe_semantic_view(conn, database, schema, name) -> dict` shaped `{"tables": [{"name"}], "relationships": [str], "dimensions": [{"table","name","dataType"}], "metrics": [...], "facts": [...]}`.

Note: the DESCRIBE row shape (`object_kind, object_name, parent_entity, property, property_value`) matches current Snowflake docs; the integration suite (Task 17) validates it against the real account. The parser reads columns by lowercase name from `cursor.description`, so column order does not matter.

- [ ] **Step 1: Write the failing test**

`backend/tests/test_discovery.py`:

```python
import pytest

from app.errors import ApiError
from app.semantic.discovery import (
    describe_semantic_view,
    list_semantic_views,
    quote_ident,
)
from tests.fakes import FakeCol, FakeConnection, FakeCursor


def test_quote_ident():
    assert quote_ident("MY_VIEW") == '"MY_VIEW"'
    with pytest.raises(ApiError):
        quote_ident('EVIL"NAME')


SHOW_DESC = [
    FakeCol("created_on"), FakeCol("name"), FakeCol("database_name"),
    FakeCol("schema_name"), FakeCol("comment"),
]


def test_list_semantic_views_scoping():
    cur = FakeCursor(
        rows=[("2026-01-01", "SALES", "ANALYTICS", "PUBLIC", "sales model")],
        description=SHOW_DESC,
    )
    conn = FakeConnection(cur)
    views = list_semantic_views(conn, database="ANALYTICS", schema="PUBLIC")
    assert cur.executed == ['SHOW SEMANTIC VIEWS IN SCHEMA "ANALYTICS"."PUBLIC"']
    assert views == [
        {"name": "SALES", "database": "ANALYTICS", "schema": "PUBLIC", "comment": "sales model"}
    ]

    list_semantic_views(conn, database="ANALYTICS")
    assert cur.executed[-1] == 'SHOW SEMANTIC VIEWS IN DATABASE "ANALYTICS"'
    list_semantic_views(conn)
    assert cur.executed[-1] == "SHOW SEMANTIC VIEWS IN ACCOUNT"


DESCRIBE_DESC = [
    FakeCol("object_kind"), FakeCol("object_name"), FakeCol("parent_entity"),
    FakeCol("property"), FakeCol("property_value"),
]

DESCRIBE_ROWS = [
    ("TABLE", "ORDERS", None, None, None),
    ("TABLE", "CUSTOMERS", None, None, None),
    ("RELATIONSHIP", "ORDERS_TO_CUSTOMERS", None, None, None),
    ("DIMENSION", "ORDER_DATE", "ORDERS", "DATA_TYPE", "DATE"),
    ("DIMENSION", "ORDER_DATE", "ORDERS", "EXPRESSION", "o_orderdate"),
    ("DIMENSION", "REGION", "CUSTOMERS", "DATA_TYPE", "VARCHAR(16777216)"),
    ("METRIC", "TOTAL_REVENUE", "ORDERS", "DATA_TYPE", "NUMBER(38,2)"),
    ("FACT", "ORDER_AMOUNT", "ORDERS", "DATA_TYPE", "NUMBER(38,2)"),
]


def test_describe_semantic_view_parses_shape():
    cur = FakeCursor(rows=DESCRIBE_ROWS, description=DESCRIBE_DESC)
    conn = FakeConnection(cur)
    detail = describe_semantic_view(conn, "ANALYTICS", "PUBLIC", "SALES")
    assert cur.executed == ['DESCRIBE SEMANTIC VIEW "ANALYTICS"."PUBLIC"."SALES"']
    assert detail["tables"] == [{"name": "ORDERS"}, {"name": "CUSTOMERS"}]
    assert detail["relationships"] == ["ORDERS_TO_CUSTOMERS"]
    assert detail["dimensions"] == [
        {"table": "ORDERS", "name": "ORDER_DATE", "dataType": "DATE"},
        {"table": "CUSTOMERS", "name": "REGION", "dataType": "VARCHAR(16777216)"},
    ]
    assert detail["metrics"] == [
        {"table": "ORDERS", "name": "TOTAL_REVENUE", "dataType": "NUMBER(38,2)"}
    ]
    assert detail["facts"] == [
        {"table": "ORDERS", "name": "ORDER_AMOUNT", "dataType": "NUMBER(38,2)"}
    ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_discovery.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.semantic'`.

- [ ] **Step 3: Write the implementation**

`backend/app/semantic/__init__.py`: empty file.

`backend/app/semantic/discovery.py`:

```python
from typing import Any

from app.errors import ApiError
from app.snowflake.gateway import map_snowflake_error


def quote_ident(name: str) -> str:
    if not name or '"' in name:
        raise ApiError("QUERY_ERROR", 400, f"Invalid identifier: {name!r}")
    return f'"{name}"'


def _execute_dicts(conn: Any, sql: str) -> list[dict]:
    cur = conn.cursor()
    try:
        try:
            cur.execute(sql)
        except Exception as exc:
            raise map_snowflake_error(exc) from exc
        names = [d.name.lower() for d in (cur.description or [])]
        return [dict(zip(names, row)) for row in cur.fetchall()]
    finally:
        cur.close()


def list_semantic_views(
    conn: Any, database: str | None = None, schema: str | None = None
) -> list[dict]:
    if database and schema:
        sql = f"SHOW SEMANTIC VIEWS IN SCHEMA {quote_ident(database)}.{quote_ident(schema)}"
    elif database:
        sql = f"SHOW SEMANTIC VIEWS IN DATABASE {quote_ident(database)}"
    else:
        sql = "SHOW SEMANTIC VIEWS IN ACCOUNT"
    return [
        {
            "name": row.get("name"),
            "database": row.get("database_name"),
            "schema": row.get("schema_name"),
            "comment": row.get("comment"),
        }
        for row in _execute_dicts(conn, sql)
    ]


_FIELD_KINDS = {"DIMENSION": "dimensions", "METRIC": "metrics", "FACT": "facts"}


def describe_semantic_view(conn: Any, database: str, schema: str, name: str) -> dict:
    fqn = f"{quote_ident(database)}.{quote_ident(schema)}.{quote_ident(name)}"
    rows = _execute_dicts(conn, f"DESCRIBE SEMANTIC VIEW {fqn}")

    tables: list[dict] = []
    relationships: list[str] = []
    fields: dict[tuple[str, str, str], dict] = {}

    for row in rows:
        kind = (row.get("object_kind") or "").upper()
        obj_name = row.get("object_name")
        parent = row.get("parent_entity")
        if kind == "TABLE" and obj_name:
            if not any(t["name"] == obj_name for t in tables):
                tables.append({"name": obj_name})
        elif kind == "RELATIONSHIP" and obj_name:
            if obj_name not in relationships:
                relationships.append(obj_name)
        elif kind in _FIELD_KINDS and obj_name:
            key = (kind, parent or "", obj_name)
            field = fields.setdefault(
                key, {"table": parent, "name": obj_name, "dataType": None}
            )
            if (row.get("property") or "").upper() == "DATA_TYPE":
                field["dataType"] = row.get("property_value")

    detail: dict = {
        "tables": tables,
        "relationships": relationships,
        "dimensions": [],
        "metrics": [],
        "facts": [],
    }
    for (kind, _parent, _name), field in fields.items():
        detail[_FIELD_KINDS[kind]].append(field)
    return detail
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_discovery.py -v`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/semantic backend/tests/test_discovery.py
git commit -m "feat: semantic view discovery with show/describe parsing"
```

---

### Task 12: Semantic query builder + API routes

**Files:**
- Create: `backend/app/semantic/query.py`, `backend/app/semantic/routes.py`
- Modify: `backend/app/main.py` (include router)
- Test: `backend/tests/test_semantic_query.py`, `backend/tests/test_semantic_routes.py`

**Interfaces:**
- Consumes: discovery (Task 11), gateway (Task 10), provider (Task 7), `current_session` (Task 8), `client`/`db` fixtures.
- Produces: pydantic models `OrderBy(field: str, direction: "asc"|"desc")` and `SemanticQueryRequest(database, schema (alias), view, dimensions: list[str], metrics: list[str], order_by alias "orderBy", limit: int|None)` where dimension/metric refs are `"TABLE.NAME"`; `build_semantic_sql(detail: dict, req: SemanticQueryRequest, *, max_rows: int) -> tuple[str, int]`; routes `GET /api/semantic-views`, `GET /api/semantic-views/{database}/{schema}/{name}`, `POST /api/query/semantic` returning `{"columns","rows","truncated","sfqid","sql"}`.

- [ ] **Step 1: Write the failing builder test**

`backend/tests/test_semantic_query.py`:

```python
import pytest

from app.errors import ApiError
from app.semantic.query import OrderBy, SemanticQueryRequest, build_semantic_sql

DETAIL = {
    "tables": [{"name": "ORDERS"}, {"name": "CUSTOMERS"}],
    "relationships": ["ORDERS_TO_CUSTOMERS"],
    "dimensions": [
        {"table": "ORDERS", "name": "ORDER_DATE", "dataType": "DATE"},
        {"table": "CUSTOMERS", "name": "REGION", "dataType": "VARCHAR(16777216)"},
    ],
    "metrics": [{"table": "ORDERS", "name": "TOTAL_REVENUE", "dataType": "NUMBER(38,2)"}],
    "facts": [],
}


def make_request(**overrides):
    body = {
        "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
        "dimensions": ["ORDERS.ORDER_DATE"], "metrics": ["ORDERS.TOTAL_REVENUE"],
    }
    body.update(overrides)
    return SemanticQueryRequest.model_validate(body)


def test_builds_semantic_view_sql():
    sql, limit = build_semantic_sql(DETAIL, make_request(), max_rows=10000)
    assert limit == 10000
    assert 'SEMANTIC_VIEW(' in sql
    assert '"ANALYTICS"."PUBLIC"."SALES"' in sql
    assert 'DIMENSIONS "ORDERS"."ORDER_DATE"' in sql
    assert 'METRICS "ORDERS"."TOTAL_REVENUE"' in sql
    assert sql.rstrip().endswith("LIMIT 10001")


def test_field_refs_are_case_insensitive_but_canonicalized():
    sql, _ = build_semantic_sql(
        DETAIL, make_request(dimensions=["orders.order_date"]), max_rows=100
    )
    assert '"ORDERS"."ORDER_DATE"' in sql


def test_unknown_field_rejected():
    with pytest.raises(ApiError, match="Unknown"):
        build_semantic_sql(DETAIL, make_request(dimensions=["ORDERS.EVIL"]), max_rows=100)


def test_injection_via_field_name_rejected():
    with pytest.raises(ApiError):
        build_semantic_sql(
            DETAIL, make_request(dimensions=['ORDERS."; DROP TABLE X;--']), max_rows=100
        )


def test_requires_at_least_one_field():
    with pytest.raises(ApiError, match="at least one"):
        build_semantic_sql(DETAIL, make_request(dimensions=[], metrics=[]), max_rows=100)


def test_order_by_must_be_selected_and_limit_clamped():
    req = make_request(orderBy=[{"field": "TOTAL_REVENUE", "direction": "desc"}], limit=50)
    sql, limit = build_semantic_sql(DETAIL, req, max_rows=10000)
    assert 'ORDER BY "TOTAL_REVENUE" DESC' in sql
    assert limit == 50
    assert sql.rstrip().endswith("LIMIT 51")

    bad = make_request(orderBy=[{"field": "REGION"}])
    with pytest.raises(ApiError, match="not selected"):
        build_semantic_sql(DETAIL, bad, max_rows=10000)

    huge = make_request(limit=999999)
    _, limit = build_semantic_sql(DETAIL, huge, max_rows=10000)
    assert limit == 10000
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_semantic_query.py -v`
Expected: FAIL with `ImportError` (module `app.semantic.query` missing).

- [ ] **Step 3: Implement the builder**

`backend/app/semantic/query.py`:

```python
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.errors import ApiError
from app.semantic.discovery import quote_ident


class OrderBy(BaseModel):
    field: str
    direction: Literal["asc", "desc"] = "asc"


class SemanticQueryRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    database: str
    schema_: str = Field(alias="schema")
    view: str
    dimensions: list[str] = []
    metrics: list[str] = []
    order_by: list[OrderBy] = Field(default_factory=list, alias="orderBy")
    limit: int | None = Field(default=None, ge=1)


def _resolve_fields(detail: dict, refs: list[str], kind: str) -> list[tuple[str, str]]:
    catalog = {
        (f["table"].upper(), f["name"].upper()): (f["table"], f["name"])
        for f in detail[kind]
    }
    resolved = []
    for ref in refs:
        if "." not in ref:
            raise ApiError("QUERY_ERROR", 400, f"Field reference must be TABLE.NAME: {ref}")
        table, name = ref.split(".", 1)
        hit = catalog.get((table.upper(), name.upper()))
        if hit is None:
            raise ApiError("QUERY_ERROR", 400, f"Unknown {kind[:-1]}: {ref}")
        resolved.append(hit)
    return resolved


def build_semantic_sql(
    detail: dict, req: SemanticQueryRequest, *, max_rows: int
) -> tuple[str, int]:
    dims = _resolve_fields(detail, req.dimensions, "dimensions")
    mets = _resolve_fields(detail, req.metrics, "metrics")
    if not dims and not mets:
        raise ApiError("QUERY_ERROR", 400, "Select at least one dimension or metric")

    parts = [f"{quote_ident(req.database)}.{quote_ident(req.schema_)}.{quote_ident(req.view)}"]
    if dims:
        parts.append(
            "DIMENSIONS " + ", ".join(f"{quote_ident(t)}.{quote_ident(n)}" for t, n in dims)
        )
    if mets:
        parts.append(
            "METRICS " + ", ".join(f"{quote_ident(t)}.{quote_ident(n)}" for t, n in mets)
        )

    selected = {name.upper(): name for _table, name in dims + mets}
    order_sql = ""
    if req.order_by:
        clauses = []
        for ob in req.order_by:
            canonical = selected.get(ob.field.upper())
            if canonical is None:
                raise ApiError("QUERY_ERROR", 400, f"orderBy field not selected: {ob.field}")
            direction = "DESC" if ob.direction == "desc" else "ASC"
            clauses.append(f"{quote_ident(canonical)} {direction}")
        order_sql = " ORDER BY " + ", ".join(clauses)

    effective_limit = min(req.limit, max_rows) if req.limit else max_rows
    sql = (
        "SELECT * FROM SEMANTIC_VIEW(\n  "
        + "\n  ".join(parts)
        + f"\n){order_sql} LIMIT {effective_limit + 1}"
    )
    return sql, effective_limit
```

- [ ] **Step 4: Run builder tests to verify they pass**

Run: `pytest tests/test_semantic_query.py -v`
Expected: 6 PASS.

- [ ] **Step 5: Write the failing route test**

`backend/tests/test_semantic_routes.py`:

```python
from app.auth.sessions import SESSION_COOKIE, create_session
from app.snowflake.provider import get_cache
from tests.fakes import FakeCol

from tests.test_discovery import DESCRIBE_DESC, DESCRIBE_ROWS, SHOW_DESC


class ScriptedCursor:
    """Routes DESCRIBE/SHOW/SELECT to canned results, recording every SQL."""

    def __init__(self):
        self.executed: list[str] = []
        self._rows: list = []
        self.description: list = []
        self.sfqid = "q-77"

    def execute(self, sql: str):
        self.executed.append(sql)
        if sql.startswith("SHOW SEMANTIC VIEWS"):
            self.description = SHOW_DESC
            self._rows = [("2026-01-01", "SALES", "ANALYTICS", "PUBLIC", None)]
        elif sql.startswith("DESCRIBE SEMANTIC VIEW"):
            self.description = DESCRIBE_DESC
            self._rows = list(DESCRIBE_ROWS)
        else:
            self.description = [FakeCol("ORDER_DATE", 3), FakeCol("TOTAL_REVENUE", 0)]
            self._rows = [("2026-01-01", 10.0), ("2026-01-02", 20.0)]
        return self

    def fetchall(self):
        return list(self._rows)

    def fetchmany(self, n: int):
        return self._rows[:n]

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def close(self):
        pass


class ScriptedConnection:
    def __init__(self):
        self.cursor_obj = ScriptedCursor()
        self.closed = False

    def cursor(self):
        return self.cursor_obj

    def is_closed(self):
        return self.closed

    def close(self):
        self.closed = True


def login(client, db):
    sess = create_session(db, account="ACME", user="ALICE", mode="dev")
    conn = ScriptedConnection()
    get_cache().put(sess.id, conn)
    client.cookies.set(SESSION_COOKIE, sess.id)
    return conn


def test_endpoints_require_auth(client):
    assert client.get("/api/semantic-views").status_code == 401
    assert client.post("/api/query/semantic", json={}).status_code == 401


def test_list_and_describe(client, db):
    conn = login(client, db)
    r = client.get("/api/semantic-views", params={"database": "ANALYTICS"})
    assert r.status_code == 200
    assert r.json()["views"][0]["name"] == "SALES"

    r = client.get("/api/semantic-views/ANALYTICS/PUBLIC/SALES")
    assert r.status_code == 200
    body = r.json()
    assert body["dimensions"][0]["name"] == "ORDER_DATE"
    assert body["metrics"][0]["name"] == "TOTAL_REVENUE"


def test_semantic_query_roundtrip(client, db):
    conn = login(client, db)
    r = client.post(
        "/api/query/semantic",
        json={
            "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
            "dimensions": ["ORDERS.ORDER_DATE"], "metrics": ["ORDERS.TOTAL_REVENUE"],
            "limit": 100,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["columns"][0]["name"] == "ORDER_DATE"
    assert body["rows"] == [["2026-01-01", 10.0], ["2026-01-02", 20.0]]
    assert body["truncated"] is False
    assert 'SEMANTIC_VIEW' in body["sql"]
    # the DESCRIBE ran before the SELECT, on the same user connection
    assert any(s.startswith("DESCRIBE") for s in conn.cursor_obj.executed)


def test_semantic_query_unknown_field_is_400(client, db):
    login(client, db)
    r = client.post(
        "/api/query/semantic",
        json={
            "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
            "dimensions": ["ORDERS.NOPE"], "metrics": [],
        },
    )
    assert r.status_code == 400
    assert r.json()["code"] == "QUERY_ERROR"
```

- [ ] **Step 6: Run route tests to verify they fail**

Run: `pytest tests/test_semantic_routes.py -v`
Expected: FAIL with 404 (routes missing).

- [ ] **Step 7: Implement the routes**

`backend/app/semantic/routes.py`:

```python
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.config import get_settings
from app.db.base import get_db
from app.db.models import DbSession
from app.semantic import discovery
from app.semantic.query import SemanticQueryRequest, build_semantic_sql
from app.snowflake import gateway
from app.snowflake.provider import get_cache

router = APIRouter()


@router.get("/api/semantic-views")
def list_views(
    database: str | None = None,
    schema: str | None = None,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    entry = get_cache().acquire(db, sess)
    with entry.lock:
        return {"views": discovery.list_semantic_views(entry.conn, database, schema)}


@router.get("/api/semantic-views/{database}/{schema}/{name}")
def describe_view(
    database: str,
    schema: str,
    name: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    entry = get_cache().acquire(db, sess)
    with entry.lock:
        return discovery.describe_semantic_view(entry.conn, database, schema, name)


@router.post("/api/query/semantic")
def query_semantic(
    req: SemanticQueryRequest,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    entry = get_cache().acquire(db, sess)
    with entry.lock:
        detail = discovery.describe_semantic_view(
            entry.conn, req.database, req.schema_, req.view
        )
        sql, effective_limit = build_semantic_sql(
            detail, req, max_rows=get_settings().row_cap
        )
        result = gateway.run_query(entry.conn, sql, max_rows=effective_limit)
    return {
        "columns": result.columns,
        "rows": result.rows,
        "truncated": result.truncated,
        "sfqid": result.sfqid,
        "sql": sql,
    }
```

In `backend/app/main.py`, next to the other router includes, add:

```python
    from app.semantic.routes import router as semantic_router

    app.include_router(semantic_router)
```

- [ ] **Step 8: Run ALL backend tests to verify they pass**

Run: `pytest -v`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add backend/app/semantic backend/app/main.py backend/tests/test_semantic_query.py backend/tests/test_semantic_routes.py
git commit -m "feat: semantic query builder and api routes"
```

---

### Task 13: Frontend scaffold + typed API client

**Files:**
- Create: `frontend/` (Vite react-ts scaffold), `frontend/src/api/client.ts`, `frontend/src/api/types.ts`, `frontend/src/setupTests.ts`
- Modify: `frontend/vite.config.ts`, `frontend/package.json` (test script)
- Test: `frontend/src/api/client.test.ts`

**Interfaces:**
- Consumes: backend API shapes (Tasks 8, 9, 12).
- Produces: `apiFetch<T>(path: string, init?: RequestInit): Promise<T>` (same-origin credentials, JSON, throws `ApiError`); `class ApiError extends Error { code: string; status: number; detail?: string | null }`; `setOnAuthExpired(handler: (() => void) | null): void` (called on any 401); types `Config { authMode: "oauth" | "dev" }`, `Me { snowflakeUser: string; snowflakeAccount: string; mode: string }`, `SemanticViewSummary { name; database; schema; comment: string | null }`, `FieldInfo { table: string; name: string; dataType: string | null }`, `SemanticViewDetail { tables: { name: string }[]; relationships: string[]; dimensions: FieldInfo[]; metrics: FieldInfo[]; facts: FieldInfo[] }`, `ColumnInfo { name: string; type: string }`, `QueryResponse { columns: ColumnInfo[]; rows: unknown[][]; truncated: boolean; sfqid: string | null; sql: string }`, `SemanticQueryBody { database; schema; view: string; dimensions: string[]; metrics: string[]; orderBy?: { field: string; direction?: "asc" | "desc" }[]; limit?: number }`.

- [ ] **Step 1: Scaffold the frontend**

Run (repo root): `npm create vite@latest frontend -- --template react-ts`
Run (from `frontend/`): `npm install` then
`npm install @tanstack/react-query react-router-dom echarts` then
`npm install -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event`

Replace `frontend/vite.config.ts`:

```ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8000",
      "/auth": "http://localhost:8000",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/setupTests.ts",
  },
});
```

Create `frontend/src/setupTests.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

In `frontend/package.json` scripts, add: `"test": "vitest run"`.

- [ ] **Step 2: Write the failing test**

`frontend/src/api/client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, setOnAuthExpired } from "./client";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setOnAuthExpired(null);
});

describe("apiFetch", () => {
  it("returns parsed JSON on success", async () => {
    mockFetch(200, { authMode: "dev" });
    await expect(apiFetch("/api/config")).resolves.toEqual({ authMode: "dev" });
  });

  it("sends JSON body with same-origin credentials", async () => {
    const fn = mockFetch(200, { ok: true });
    await apiFetch("/auth/dev-login", {
      method: "POST",
      body: JSON.stringify({ account: "a" }),
    });
    const [, init] = fn.mock.calls[0];
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("throws ApiError built from the error envelope", async () => {
    mockFetch(400, { code: "QUERY_ERROR", message: "bad field", detail: null });
    const err = await apiFetch("/api/query/semantic").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("QUERY_ERROR");
    expect(err.message).toBe("bad field");
    expect(err.status).toBe(400);
  });

  it("fires the auth-expired handler on 401", async () => {
    mockFetch(401, { code: "AUTH_EXPIRED", message: "Sign in required", detail: null });
    const handler = vi.fn();
    setOnAuthExpired(handler);
    const err = await apiFetch("/api/me").catch((e) => e);
    expect(handler).toHaveBeenCalledOnce();
    expect(err.code).toBe("AUTH_EXPIRED");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run (from `frontend/`): `npm test`
Expected: FAIL — cannot resolve `./client`.

- [ ] **Step 4: Write the implementation**

`frontend/src/api/types.ts`:

```ts
export interface Config {
  authMode: "oauth" | "dev";
}

export interface Me {
  snowflakeUser: string;
  snowflakeAccount: string;
  mode: string;
}

export interface SemanticViewSummary {
  name: string;
  database: string;
  schema: string;
  comment: string | null;
}

export interface FieldInfo {
  table: string;
  name: string;
  dataType: string | null;
}

export interface SemanticViewDetail {
  tables: { name: string }[];
  relationships: string[];
  dimensions: FieldInfo[];
  metrics: FieldInfo[];
  facts: FieldInfo[];
}

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface QueryResponse {
  columns: ColumnInfo[];
  rows: unknown[][];
  truncated: boolean;
  sfqid: string | null;
  sql: string;
}

export interface SemanticQueryBody {
  database: string;
  schema: string;
  view: string;
  dimensions: string[];
  metrics: string[];
  orderBy?: { field: string; direction?: "asc" | "desc" }[];
  limit?: number;
}
```

`frontend/src/api/client.ts`:

```ts
export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public detail?: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let authExpiredHandler: (() => void) | null = null;

export function setOnAuthExpired(handler: (() => void) | null): void {
  authExpiredHandler = handler;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers,
  });
  if (response.status === 401) {
    authExpiredHandler?.();
    throw new ApiError("AUTH_EXPIRED", 401, "Sign in required");
  }
  if (!response.ok) {
    let body: { code?: string; message?: string; detail?: string | null } = {};
    try {
      body = await response.json();
    } catch {
      // non-JSON error body; fall through to defaults
    }
    throw new ApiError(
      body.code ?? "QUERY_ERROR",
      response.status,
      body.message ?? response.statusText,
      body.detail,
    );
  }
  return (await response.json()) as T;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: 4 PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend
git commit -m "feat: frontend scaffold with typed api client"
```

---

### Task 14: App routing, auth guard, login page

**Files:**
- Create: `frontend/src/auth/LoginPage.tsx`, `frontend/src/auth/useMe.ts`, `frontend/src/explorer/ExplorerPage.tsx` (placeholder, replaced in Task 15)
- Modify: `frontend/src/App.tsx`, `frontend/src/index.css`; delete `frontend/src/App.css` and its import
- Test: `frontend/src/auth/LoginPage.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `setOnAuthExpired`, types (Task 13).
- Produces: routes `/login` (LoginPage) and `/` (auth-guarded ExplorerPage); `useMe()` hook returning TanStack Query result for `Me`; LoginPage renders an OAuth link (`/auth/login`) in oauth mode and a dev-login form (account, user, authenticator select, password when authenticator=password) in dev mode, navigating to `/` on success. Task 15 replaces the ExplorerPage placeholder.

- [ ] **Step 1: Write the failing test**

`frontend/src/auth/LoginPage.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  setOnAuthExpired: vi.fn(),
  ApiError: class extends Error {},
}));

import { apiFetch } from "../api/client";
import LoginPage from "./LoginPage";

const apiFetchMock = vi.mocked(apiFetch);

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("LoginPage", () => {
  it("shows the OAuth link in oauth mode", async () => {
    apiFetchMock.mockResolvedValueOnce({ authMode: "oauth" });
    renderPage();
    const link = await screen.findByRole("link", { name: /sign in with snowflake/i });
    expect(link).toHaveAttribute("href", "/auth/login");
  });

  it("submits the dev-login form in dev mode", async () => {
    apiFetchMock.mockResolvedValueOnce({ authMode: "dev" });
    renderPage();
    await screen.findByLabelText(/account/i);
    apiFetchMock.mockResolvedValueOnce({
      snowflakeUser: "ALICE", snowflakeAccount: "ACME", mode: "dev",
    });
    await userEvent.type(screen.getByLabelText(/account/i), "myorg-myaccount");
    await userEvent.type(screen.getByLabelText(/user/i), "alice");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenLastCalledWith("/auth/dev-login", {
        method: "POST",
        body: JSON.stringify({
          account: "myorg-myaccount",
          user: "alice",
          authenticator: "externalbrowser",
          password: null,
        }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./LoginPage`.

- [ ] **Step 3: Write the implementation**

`frontend/src/auth/useMe.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import type { Me } from "../api/types";

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<Me>("/api/me"),
    retry: false,
  });
}
```

`frontend/src/auth/LoginPage.tsx`:

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, ApiError } from "../api/client";
import type { Config } from "../api/types";

export default function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => apiFetch<Config>("/api/config"),
  });
  const [account, setAccount] = useState("");
  const [user, setUser] = useState("");
  const [authenticator, setAuthenticator] = useState<"externalbrowser" | "password">(
    "externalbrowser",
  );
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (config.isLoading) return <p>Loading...</p>;
  if (config.isError || !config.data) return <p>Cannot reach the backend.</p>;

  if (config.data.authMode === "oauth") {
    return (
      <main className="login">
        <h1>SemanticUI</h1>
        <a className="button" href="/auth/login">
          Sign in with Snowflake
        </a>
      </main>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/auth/dev-login", {
        method: "POST",
        body: JSON.stringify({
          account,
          user,
          authenticator,
          password: authenticator === "password" ? password : null,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <h1>SemanticUI</h1>
      <p>Dev mode: sign in with your own Snowflake credentials.</p>
      <form onSubmit={submit}>
        <label>
          Account
          <input value={account} onChange={(e) => setAccount(e.target.value)} required />
        </label>
        <label>
          User
          <input value={user} onChange={(e) => setUser(e.target.value)} required />
        </label>
        <label>
          Authenticator
          <select
            value={authenticator}
            onChange={(e) =>
              setAuthenticator(e.target.value as "externalbrowser" | "password")
            }
          >
            <option value="externalbrowser">External browser (SSO)</option>
            <option value="password">Password</option>
          </select>
        </label>
        {authenticator === "password" && (
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}
```

`frontend/src/explorer/ExplorerPage.tsx` (placeholder until Task 15):

```tsx
export default function ExplorerPage() {
  return <main>Explorer coming in Task 15</main>;
}
```

Replace `frontend/src/App.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";
import { setOnAuthExpired } from "./api/client";
import LoginPage from "./auth/LoginPage";
import { useMe } from "./auth/useMe";
import ExplorerPage from "./explorer/ExplorerPage";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  const me = useMe();
  if (me.isLoading) return <p>Loading...</p>;
  if (me.isError) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AuthExpiredBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    setOnAuthExpired(() => navigate("/login"));
    return () => setOnAuthExpired(null);
  }, [navigate]);
  return null;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthExpiredBridge />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <ExplorerPage />
              </RequireAuth>
            }
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
```

Replace `frontend/src/index.css` (light theme, palette chrome tokens; delete `frontend/src/App.css` and remove its import from any file):

```css
:root {
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-secondary: #52514e;
  --ink-muted: #898781;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11, 11, 11, 0.1);
  --accent: #2a78d6;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}

.login {
  max-width: 360px;
  margin: 10vh auto;
  padding: 24px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.login form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.login label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 14px;
  color: var(--ink-secondary);
}

input,
select {
  padding: 8px;
  border: 1px solid var(--axis);
  border-radius: 4px;
  font: inherit;
}

button,
.button {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  background: var(--accent);
  color: #ffffff;
  font: inherit;
  cursor: pointer;
  text-decoration: none;
  text-align: center;
  display: inline-block;
}

button:disabled {
  opacity: 0.6;
  cursor: default;
}

[role="alert"] {
  color: #d03b3b;
  margin: 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all frontend tests PASS (client + LoginPage).

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat: app routing with auth guard and login page"
```

---

### Task 15: Explorer page (view tree + field selection)

**Files:**
- Create: `frontend/src/explorer/groupViews.ts`, `frontend/src/explorer/ViewTree.tsx`, `frontend/src/explorer/FieldPanel.tsx`
- Modify: `frontend/src/explorer/ExplorerPage.tsx` (replace placeholder), `frontend/src/index.css` (append layout styles)
- Test: `frontend/src/explorer/groupViews.test.ts`, `frontend/src/explorer/FieldPanel.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, types (Task 13), `useMe` (Task 14).
- Produces: `groupViews(views: SemanticViewSummary[]): Record<string, Record<string, SemanticViewSummary[]>>` (database -> schema -> views); `ViewTree({ views, selected, onSelect })`; `FieldPanel({ detail, selection, onToggle, onRun, running })` where `selection = { dimensions: string[]; metrics: string[] }` and refs are `"TABLE.NAME"`; ExplorerPage holds selection state, runs `POST /api/query/semantic`, and renders the result through a `QueryResults` stub (`<pre data-testid="raw-result">`) that Task 16 replaces with `QueryPanel`. Also a header with the signed-in user and a Logout button (`POST /auth/logout`, then navigate to `/login`).

- [ ] **Step 1: Write the failing tests**

`frontend/src/explorer/groupViews.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { groupViews } from "./groupViews";

describe("groupViews", () => {
  it("groups by database then schema", () => {
    const grouped = groupViews([
      { name: "SALES", database: "ANALYTICS", schema: "PUBLIC", comment: null },
      { name: "OPS", database: "ANALYTICS", schema: "INTERNAL", comment: null },
      { name: "HR", database: "PEOPLE", schema: "PUBLIC", comment: null },
    ]);
    expect(Object.keys(grouped)).toEqual(["ANALYTICS", "PEOPLE"]);
    expect(Object.keys(grouped.ANALYTICS)).toEqual(["PUBLIC", "INTERNAL"]);
    expect(grouped.ANALYTICS.PUBLIC[0].name).toBe("SALES");
  });
});
```

`frontend/src/explorer/FieldPanel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import FieldPanel from "./FieldPanel";

const DETAIL = {
  tables: [{ name: "ORDERS" }],
  relationships: [],
  dimensions: [{ table: "ORDERS", name: "ORDER_DATE", dataType: "DATE" }],
  metrics: [{ table: "ORDERS", name: "TOTAL_REVENUE", dataType: "NUMBER(38,2)" }],
  facts: [],
};

describe("FieldPanel", () => {
  it("toggles fields and runs", async () => {
    const onToggle = vi.fn();
    const onRun = vi.fn();
    render(
      <FieldPanel
        detail={DETAIL}
        selection={{ dimensions: ["ORDERS.ORDER_DATE"], metrics: [] }}
        onToggle={onToggle}
        onRun={onRun}
        running={false}
      />,
    );
    const dim = screen.getByRole("checkbox", { name: /ORDERS\.ORDER_DATE/ });
    expect(dim).toBeChecked();
    await userEvent.click(
      screen.getByRole("checkbox", { name: /ORDERS\.TOTAL_REVENUE/ }),
    );
    expect(onToggle).toHaveBeenCalledWith("metrics", "ORDERS.TOTAL_REVENUE");
    await userEvent.click(screen.getByRole("button", { name: /run/i }));
    expect(onRun).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot resolve `./groupViews` / `./FieldPanel`.

- [ ] **Step 3: Write the implementation**

`frontend/src/explorer/groupViews.ts`:

```ts
import type { SemanticViewSummary } from "../api/types";

export function groupViews(
  views: SemanticViewSummary[],
): Record<string, Record<string, SemanticViewSummary[]>> {
  const grouped: Record<string, Record<string, SemanticViewSummary[]>> = {};
  for (const view of views) {
    grouped[view.database] ??= {};
    grouped[view.database][view.schema] ??= [];
    grouped[view.database][view.schema].push(view);
  }
  return grouped;
}
```

`frontend/src/explorer/ViewTree.tsx`:

```tsx
import type { SemanticViewSummary } from "../api/types";
import { groupViews } from "./groupViews";

interface Props {
  views: SemanticViewSummary[];
  selected: SemanticViewSummary | null;
  onSelect: (view: SemanticViewSummary) => void;
}

export default function ViewTree({ views, selected, onSelect }: Props) {
  const grouped = groupViews(views);
  return (
    <nav className="view-tree">
      {Object.entries(grouped).map(([database, schemas]) => (
        <div key={database}>
          <h3>{database}</h3>
          {Object.entries(schemas).map(([schema, schemaViews]) => (
            <div key={schema} className="schema-group">
              <h4>{schema}</h4>
              <ul>
                {schemaViews.map((view) => (
                  <li key={view.name}>
                    <button
                      className={
                        selected?.name === view.name &&
                        selected?.database === view.database &&
                        selected?.schema === view.schema
                          ? "view-item selected"
                          : "view-item"
                      }
                      onClick={() => onSelect(view)}
                      title={view.comment ?? undefined}
                    >
                      {view.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}
```

`frontend/src/explorer/FieldPanel.tsx`:

```tsx
import type { FieldInfo, SemanticViewDetail } from "../api/types";

export interface Selection {
  dimensions: string[];
  metrics: string[];
}

interface Props {
  detail: SemanticViewDetail;
  selection: Selection;
  onToggle: (kind: "dimensions" | "metrics", ref: string) => void;
  onRun: () => void;
  running: boolean;
}

function refOf(field: FieldInfo): string {
  return `${field.table}.${field.name}`;
}

function FieldGroup({
  title, kind, fields, selection, onToggle,
}: {
  title: string;
  kind: "dimensions" | "metrics";
  fields: FieldInfo[];
  selection: Selection;
  onToggle: Props["onToggle"];
}) {
  return (
    <section>
      <h4>{title}</h4>
      {fields.map((field) => {
        const ref = refOf(field);
        return (
          <label key={ref} className="field-row">
            <input
              type="checkbox"
              checked={selection[kind].includes(ref)}
              onChange={() => onToggle(kind, ref)}
              aria-label={ref}
            />
            <span>{ref}</span>
            {field.dataType && <small>{field.dataType}</small>}
          </label>
        );
      })}
    </section>
  );
}

export default function FieldPanel({ detail, selection, onToggle, onRun, running }: Props) {
  const canRun = selection.dimensions.length + selection.metrics.length > 0;
  return (
    <aside className="field-panel">
      <FieldGroup
        title="Dimensions" kind="dimensions" fields={detail.dimensions}
        selection={selection} onToggle={onToggle}
      />
      <FieldGroup
        title="Metrics" kind="metrics" fields={detail.metrics}
        selection={selection} onToggle={onToggle}
      />
      <button onClick={onRun} disabled={!canRun || running}>
        {running ? "Running..." : "Run"}
      </button>
    </aside>
  );
}
```

Replace `frontend/src/explorer/ExplorerPage.tsx`:

```tsx
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, ApiError } from "../api/client";
import type {
  QueryResponse,
  SemanticQueryBody,
  SemanticViewDetail,
  SemanticViewSummary,
} from "../api/types";
import { useMe } from "../auth/useMe";
import FieldPanel, { type Selection } from "./FieldPanel";
import ViewTree from "./ViewTree";

// Replaced by QueryPanel in Task 16.
function QueryResults({ result }: { result: QueryResponse }) {
  return <pre data-testid="raw-result">{JSON.stringify(result, null, 2)}</pre>;
}

export default function ExplorerPage() {
  const navigate = useNavigate();
  const me = useMe();
  const [selectedView, setSelectedView] = useState<SemanticViewSummary | null>(null);
  const [selection, setSelection] = useState<Selection>({ dimensions: [], metrics: [] });

  const views = useQuery({
    queryKey: ["semantic-views"],
    queryFn: () =>
      apiFetch<{ views: SemanticViewSummary[] }>("/api/semantic-views"),
  });

  const detail = useQuery({
    queryKey: ["semantic-view", selectedView?.database, selectedView?.schema, selectedView?.name],
    enabled: selectedView !== null,
    queryFn: () =>
      apiFetch<SemanticViewDetail>(
        `/api/semantic-views/${selectedView!.database}/${selectedView!.schema}/${selectedView!.name}`,
      ),
  });

  const run = useMutation({
    mutationFn: (body: SemanticQueryBody) =>
      apiFetch<QueryResponse>("/api/query/semantic", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });

  function selectView(view: SemanticViewSummary) {
    setSelectedView(view);
    setSelection({ dimensions: [], metrics: [] });
    run.reset();
  }

  function toggle(kind: "dimensions" | "metrics", ref: string) {
    setSelection((prev) => ({
      ...prev,
      [kind]: prev[kind].includes(ref)
        ? prev[kind].filter((r) => r !== ref)
        : [...prev[kind], ref],
    }));
  }

  function runQuery() {
    if (!selectedView) return;
    run.mutate({
      database: selectedView.database,
      schema: selectedView.schema,
      view: selectedView.name,
      dimensions: selection.dimensions,
      metrics: selection.metrics,
    });
  }

  async function logout() {
    await apiFetch("/auth/logout", { method: "POST" });
    navigate("/login");
  }

  return (
    <div className="explorer">
      <header className="topbar">
        <strong>SemanticUI</strong>
        <span>
          {me.data ? `${me.data.snowflakeUser} @ ${me.data.snowflakeAccount}` : ""}
          <button className="link" onClick={logout}>
            Log out
          </button>
        </span>
      </header>
      <div className="columns">
        <div className="left">
          {views.isLoading && <p>Loading views...</p>}
          {views.isError && <p role="alert">Failed to load semantic views.</p>}
          {views.data && (
            <ViewTree
              views={views.data.views}
              selected={selectedView}
              onSelect={selectView}
            />
          )}
        </div>
        <div className="middle">
          {selectedView && detail.data && (
            <FieldPanel
              detail={detail.data}
              selection={selection}
              onToggle={toggle}
              onRun={runQuery}
              running={run.isPending}
            />
          )}
          {selectedView && detail.isLoading && <p>Describing view...</p>}
          {!selectedView && <p>Select a semantic view to begin.</p>}
        </div>
        <div className="main">
          {run.isError && (
            <p role="alert">
              {run.error instanceof ApiError ? run.error.message : "Query failed"}
            </p>
          )}
          {run.data && <QueryResults result={run.data} />}
        </div>
      </div>
    </div>
  );
}
```

Append to `frontend/src/index.css`:

```css
.explorer {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.columns {
  display: flex;
  flex: 1;
  min-height: 0;
}

.left,
.middle {
  width: 240px;
  overflow-y: auto;
  padding: 12px;
  border-right: 1px solid var(--border);
  background: var(--surface);
}

.main {
  flex: 1;
  overflow: auto;
  padding: 16px;
}

.view-tree h3 {
  font-size: 13px;
  color: var(--ink-secondary);
  margin: 8px 0 2px;
}

.view-tree h4 {
  font-size: 12px;
  color: var(--ink-muted);
  margin: 6px 0 2px;
}

.view-tree ul {
  list-style: none;
  margin: 0;
  padding: 0 0 0 8px;
}

.view-item {
  background: none;
  color: var(--ink);
  text-align: left;
  width: 100%;
  padding: 4px 8px;
}

.view-item.selected {
  background: var(--accent);
  color: #ffffff;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  font-size: 13px;
}

.field-row small {
  color: var(--ink-muted);
}

.link {
  background: none;
  color: var(--accent);
  padding: 0 0 0 12px;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all frontend tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat: semantic view explorer with tree and field selection"
```

---

### Task 16: Query panel — results table, auto-chart, SQL preview

**Files:**
- Create: `frontend/src/query/palette.ts`, `frontend/src/query/chooseChart.ts`, `frontend/src/query/buildChartOption.ts`, `frontend/src/query/AutoChart.tsx`, `frontend/src/query/ResultsTable.tsx`, `frontend/src/query/SqlPreview.tsx`, `frontend/src/query/QueryPanel.tsx`
- Modify: `frontend/src/explorer/ExplorerPage.tsx` (replace `QueryResults` stub with `QueryPanel`), `frontend/src/index.css` (append)
- Test: `frontend/src/query/chooseChart.test.ts`, `frontend/src/query/buildChartOption.test.ts`, `frontend/src/query/ResultsTable.test.tsx`

**Interfaces:**
- Consumes: `QueryResponse`, `SemanticViewDetail` types (Task 13), ExplorerPage state (Task 15).
- Produces: `SERIES_COLORS: string[]` (8 validated categorical hexes) and `CHART_INK` tokens; `chooseChart(dimCount: number, metricCount: number, dimType?: string): "bar" | "line" | "none"`; `buildChartOption(kind, categories: string[], series: { name: string; data: (number | null)[]; colorIndex: number }[])` returning an ECharts option object; `<QueryPanel result detail selection />` rendering truncated banner + AutoChart (when applicable) + ResultsTable (always — this is the accessible table view) + SqlPreview.

Chart rules (from the validated reference palette; do not invent colors):
- Colors come only from `SERIES_COLORS`, assigned by the metric's index in `detail.metrics` (stable identity — unchecking one metric must not repaint the others).
- Exactly 1 dimension + >=1 metric -> bar (line when the dimension type matches /DATE|TIMESTAMP/i); anything else -> no chart, table only.
- Legend only when >=2 series; single series is named by the panel title.
- One y-axis only. Bars: 4px top-rounded, anchored to baseline. Lines: 2px width. Grid/axis use `CHART_INK` (never series colors for text). Tooltip on hover (axis trigger).

- [ ] **Step 1: Write the failing tests**

`frontend/src/query/chooseChart.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chooseChart } from "./chooseChart";

describe("chooseChart", () => {
  it("bar for 1 dimension + metrics", () => {
    expect(chooseChart(1, 1, "TEXT")).toBe("bar");
    expect(chooseChart(1, 3, "FIXED")).toBe("bar");
  });
  it("line when the dimension is date-like", () => {
    expect(chooseChart(1, 1, "DATE")).toBe("line");
    expect(chooseChart(1, 2, "TIMESTAMP_NTZ")).toBe("line");
  });
  it("none for 0 or 2+ dimensions or no metrics", () => {
    expect(chooseChart(0, 2)).toBe("none");
    expect(chooseChart(2, 1, "TEXT")).toBe("none");
    expect(chooseChart(1, 0, "TEXT")).toBe("none");
  });
});
```

`frontend/src/query/buildChartOption.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildChartOption } from "./buildChartOption";
import { SERIES_COLORS } from "./palette";

const categories = ["2026-01-01", "2026-01-02"];

describe("buildChartOption", () => {
  it("colors series by stable colorIndex", () => {
    const option = buildChartOption("bar", categories, [
      { name: "TOTAL_REVENUE", data: [10, 20], colorIndex: 2 },
    ]);
    expect(option.series[0].itemStyle.color).toBe(SERIES_COLORS[2]);
  });

  it("bar marks are top-rounded; lines are 2px", () => {
    const bar = buildChartOption("bar", categories, [
      { name: "A", data: [1, 2], colorIndex: 0 },
    ]);
    expect(bar.series[0].itemStyle.borderRadius).toEqual([4, 4, 0, 0]);
    const line = buildChartOption("line", categories, [
      { name: "A", data: [1, 2], colorIndex: 0 },
    ]);
    expect(line.series[0].lineStyle.width).toBe(2);
  });

  it("legend only for 2+ series", () => {
    const one = buildChartOption("bar", categories, [
      { name: "A", data: [1, 2], colorIndex: 0 },
    ]);
    expect(one.legend.show).toBe(false);
    const two = buildChartOption("bar", categories, [
      { name: "A", data: [1, 2], colorIndex: 0 },
      { name: "B", data: [3, 4], colorIndex: 1 },
    ]);
    expect(two.legend.show).toBe(true);
  });
});
```

`frontend/src/query/ResultsTable.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ResultsTable from "./ResultsTable";

const RESULT = {
  columns: [{ name: "ORDER_DATE", type: "DATE" }, { name: "TOTAL_REVENUE", type: "FIXED" }],
  rows: [["2026-01-01", 10], ["2026-01-02", 20]],
  truncated: true,
  sfqid: "q-1",
  sql: "SELECT 1",
};

describe("ResultsTable", () => {
  it("renders headers, rows, and the truncated banner", () => {
    render(<ResultsTable result={RESULT} />);
    expect(screen.getByRole("columnheader", { name: "ORDER_DATE" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "2026-01-01" })).toBeInTheDocument();
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the implementation**

`frontend/src/query/palette.ts` (validated reference palette, light mode — swap for brand later):

```ts
// Categorical slots 1-8, light surface. Order is the CVD-safety mechanism;
// never re-order or cycle. Source: dataviz reference palette.
export const SERIES_COLORS = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
  "#4a3aa7", // violet
  "#e34948", // red
];

export const CHART_INK = {
  primary: "#0b0b0b",
  secondary: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  surface: "#fcfcfb",
};
```

`frontend/src/query/chooseChart.ts`:

```ts
export type ChartKind = "bar" | "line" | "none";

export function chooseChart(
  dimCount: number,
  metricCount: number,
  dimType?: string,
): ChartKind {
  if (dimCount !== 1 || metricCount < 1) return "none";
  if (dimType && /DATE|TIMESTAMP/i.test(dimType)) return "line";
  return "bar";
}
```

`frontend/src/query/buildChartOption.ts`:

```ts
import { CHART_INK, SERIES_COLORS } from "./palette";

export interface ChartSeries {
  name: string;
  data: (number | null)[];
  colorIndex: number;
}

export function buildChartOption(
  kind: "bar" | "line",
  categories: string[],
  series: ChartSeries[],
) {
  return {
    backgroundColor: "transparent",
    grid: { left: 48, right: 16, top: 24, bottom: series.length > 1 ? 56 : 32 },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: kind === "line" ? "line" : "shadow" },
    },
    legend: {
      show: series.length > 1,
      bottom: 0,
      textStyle: { color: CHART_INK.secondary },
    },
    xAxis: {
      type: "category",
      data: categories,
      axisLine: { lineStyle: { color: CHART_INK.axis } },
      axisLabel: { color: CHART_INK.muted },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: CHART_INK.grid } },
      axisLabel: { color: CHART_INK.muted },
    },
    series: series.map((s) =>
      kind === "bar"
        ? {
            name: s.name,
            type: "bar",
            data: s.data,
            barGap: "10%",
            itemStyle: {
              color: SERIES_COLORS[s.colorIndex % SERIES_COLORS.length],
              borderRadius: [4, 4, 0, 0],
            },
          }
        : {
            name: s.name,
            type: "line",
            data: s.data,
            showSymbol: false,
            lineStyle: { width: 2 },
            itemStyle: {
              color: SERIES_COLORS[s.colorIndex % SERIES_COLORS.length],
            },
          },
    ),
  };
}
```

`frontend/src/query/AutoChart.tsx`:

```tsx
import * as echarts from "echarts";
import { useEffect, useRef } from "react";
import { buildChartOption, type ChartSeries } from "./buildChartOption";

interface Props {
  kind: "bar" | "line";
  categories: string[];
  series: ChartSeries[];
}

export default function AutoChart({ kind, categories, series }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "svg" });
    chart.setOption(buildChartOption(kind, categories, series));
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [kind, categories, series]);

  return <div ref={ref} className="auto-chart" role="img" aria-label="Query result chart" />;
}
```

`frontend/src/query/ResultsTable.tsx`:

```tsx
import type { QueryResponse } from "../api/types";

export default function ResultsTable({ result }: { result: QueryResponse }) {
  return (
    <div className="results">
      {result.truncated && (
        <p className="banner">Results truncated to {result.rows.length} rows.</p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {result.columns.map((col) => (
                <th key={col.name} scope="col">
                  {col.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i}>
                {row.map((value, j) => (
                  <td key={j}>{value === null ? "" : String(value)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

`frontend/src/query/SqlPreview.tsx`:

```tsx
export default function SqlPreview({ sql }: { sql: string }) {
  return (
    <details className="sql-preview">
      <summary>SQL sent</summary>
      <pre>{sql}</pre>
    </details>
  );
}
```

`frontend/src/query/QueryPanel.tsx`:

```tsx
import type { QueryResponse, SemanticViewDetail } from "../api/types";
import type { Selection } from "../explorer/FieldPanel";
import AutoChart from "./AutoChart";
import { chooseChart } from "./chooseChart";
import ResultsTable from "./ResultsTable";
import SqlPreview from "./SqlPreview";

interface Props {
  result: QueryResponse;
  detail: SemanticViewDetail;
  selection: Selection;
}

function fieldName(ref: string): string {
  return ref.split(".", 2)[1] ?? ref;
}

export default function QueryPanel({ result, detail, selection }: Props) {
  const dimName = selection.dimensions[0] ? fieldName(selection.dimensions[0]) : undefined;
  const dimCol = result.columns.find(
    (c) => c.name.toUpperCase() === dimName?.toUpperCase(),
  );
  const kind = chooseChart(
    selection.dimensions.length,
    selection.metrics.length,
    dimCol?.type,
  );

  let chart = null;
  if (kind !== "none" && dimCol) {
    const dimIndex = result.columns.indexOf(dimCol);
    const categories = result.rows.map((row) => String(row[dimIndex] ?? ""));
    const series = selection.metrics.flatMap((ref) => {
      const name = fieldName(ref);
      const colIndex = result.columns.findIndex(
        (c) => c.name.toUpperCase() === name.toUpperCase(),
      );
      if (colIndex < 0) return [];
      // Stable identity: color slot = metric's index in the view's metric list.
      const colorIndex = Math.max(
        0,
        detail.metrics.findIndex(
          (m) => m.name.toUpperCase() === name.toUpperCase(),
        ),
      );
      return [
        {
          name,
          colorIndex,
          data: result.rows.map((row) => {
            const value = row[colIndex];
            return value === null || value === undefined ? null : Number(value);
          }),
        },
      ];
    });
    chart = <AutoChart kind={kind} categories={categories} series={series} />;
  }

  return (
    <div className="query-panel">
      {chart}
      <ResultsTable result={result} />
      <SqlPreview sql={result.sql} />
    </div>
  );
}
```

In `frontend/src/explorer/ExplorerPage.tsx`: delete the `QueryResults` stub, add `import QueryPanel from "../query/QueryPanel";`, and replace `{run.data && <QueryResults result={run.data} />}` with:

```tsx
          {run.data && detail.data && (
            <QueryPanel result={run.data} detail={detail.data} selection={selection} />
          )}
```

Append to `frontend/src/index.css`:

```css
.auto-chart {
  height: 320px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 16px;
}

.banner {
  background: #fff7e0;
  border: 1px solid var(--grid);
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 13px;
}

.table-scroll {
  overflow-x: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
}

table {
  border-collapse: collapse;
  width: 100%;
  font-size: 13px;
}

th,
td {
  text-align: left;
  padding: 6px 10px;
  border-bottom: 1px solid var(--grid);
}

td {
  font-variant-numeric: tabular-nums;
}

th {
  color: var(--ink-secondary);
  position: sticky;
  top: 0;
  background: var(--surface);
}

.sql-preview {
  margin-top: 12px;
  color: var(--ink-secondary);
}

.sql-preview pre {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px;
  overflow-x: auto;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all frontend tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat: query panel with auto-chart, results table, sql preview"
```

---

### Task 17: Integration suite, README, manual end-to-end verification

**Files:**
- Create: `backend/tests/integration/test_snowflake_it.py`, `README.md`
- Test: the integration suite itself + a manual smoke checklist

**Interfaces:**
- Consumes: everything.
- Produces: env-gated integration tests (`pytest -m integration` with `SEMANTICUI_IT_*` vars); README covering setup, dev-mode login, OAuth security integration SQL, and the smoke checklist.

- [ ] **Step 1: Write the integration tests**

`backend/tests/integration/test_snowflake_it.py`:

```python
"""Runs against a real Snowflake account. Set env vars to enable:

SEMANTICUI_IT_ACCOUNT, SEMANTICUI_IT_USER, SEMANTICUI_IT_PASSWORD
Optional: SEMANTICUI_IT_DATABASE, SEMANTICUI_IT_SCHEMA, SEMANTICUI_IT_VIEW

Run: pytest -m integration -v
"""
import os

import pytest

from app.semantic.discovery import describe_semantic_view, list_semantic_views
from app.semantic.query import SemanticQueryRequest, build_semantic_sql
from app.snowflake import connect as sf_connect
from app.snowflake.gateway import run_query

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.environ.get("SEMANTICUI_IT_ACCOUNT"),
        reason="SEMANTICUI_IT_* env vars not set",
    ),
]


@pytest.fixture(scope="module")
def conn():
    connection = sf_connect.connect_dev(
        account=os.environ["SEMANTICUI_IT_ACCOUNT"],
        user=os.environ["SEMANTICUI_IT_USER"],
        authenticator="password",
        password=os.environ["SEMANTICUI_IT_PASSWORD"],
    )
    yield connection
    connection.close()


@pytest.fixture(scope="module")
def view_ref(conn):
    db = os.environ.get("SEMANTICUI_IT_DATABASE")
    schema = os.environ.get("SEMANTICUI_IT_SCHEMA")
    name = os.environ.get("SEMANTICUI_IT_VIEW")
    if db and schema and name:
        return db, schema, name
    views = list_semantic_views(conn)
    assert views, "account has no semantic views visible to this user"
    v = views[0]
    return v["database"], v["schema"], v["name"]


def test_probe_identity(conn):
    account, user = sf_connect.probe_identity(conn)
    assert account and user


def test_list_semantic_views(conn):
    views = list_semantic_views(conn)
    assert isinstance(views, list)
    assert all(v["name"] and v["database"] and v["schema"] for v in views)


def test_describe_parses_real_output(conn, view_ref):
    detail = describe_semantic_view(conn, *view_ref)
    assert detail["tables"], "parser found no logical tables - DESCRIBE shape changed?"
    assert detail["dimensions"] or detail["metrics"], (
        "parser found no dimensions/metrics - DESCRIBE shape changed?"
    )


def test_semantic_query_roundtrip(conn, view_ref):
    db, schema, name = view_ref
    detail = describe_semantic_view(conn, db, schema, name)
    dims = [f"{d['table']}.{d['name']}" for d in detail["dimensions"][:1]]
    mets = [f"{m['table']}.{m['name']}" for m in detail["metrics"][:1]]
    req = SemanticQueryRequest.model_validate(
        {
            "database": db, "schema": schema, "view": name,
            "dimensions": dims, "metrics": mets, "limit": 5,
        }
    )
    sql, limit = build_semantic_sql(detail, req, max_rows=10000)
    result = run_query(conn, sql, max_rows=limit)
    assert result.columns
    assert len(result.rows) <= 5
```

- [ ] **Step 2: Run the integration suite against the real account**

Set the `SEMANTICUI_IT_*` env vars for the dev account, then:

Run: `pytest -m integration -v`
Expected: 4 PASS (this validates the DESCRIBE parser and SEMANTIC_VIEW() SQL against reality). If `test_describe_parses_real_output` fails, capture the real DESCRIBE output, update the parser + the fixtures in `tests/test_discovery.py` to match, and re-run both suites.

- [ ] **Step 3: Write the README**

`README.md` (repo root):

```markdown
# SemanticUI

PowerBI-style reporting on top of Snowflake semantic views. Every query runs
with the signed-in user's own Snowflake credentials - Snowflake RBAC is the
sole authority on data access.

Spec: docs/superpowers/specs/2026-08-14-foundation-auth-query-gateway-design.md

## Prerequisites

- Python 3.12+, Node 20+, Docker (for local Postgres)
- A Snowflake account with at least one semantic view

## Local development (dev auth mode - no security integration needed)

    docker compose up -d postgres
    cd backend
    python -m venv .venv
    .venv\Scripts\activate        # Windows (source .venv/bin/activate elsewhere)
    pip install -e ".[dev]"
    copy .env.example .env        # defaults are fine for dev mode
    alembic upgrade head
    uvicorn app.main:app --reload --port 8000

In a second terminal:

    cd frontend
    npm install
    npm run dev

Open http://localhost:5173, choose "External browser (SSO)" or "Password",
and sign in with YOUR Snowflake account/user. External browser pops your
default browser once for Snowflake SSO/login - no OAuth setup required.

## Production (Snowflake built-in OAuth)

1. Create the security integration in Snowflake (ACCOUNTADMIN):

       CREATE SECURITY INTEGRATION semanticui_oauth
         TYPE = OAUTH
         OAUTH_CLIENT = CUSTOM
         OAUTH_CLIENT_TYPE = 'CONFIDENTIAL'
         OAUTH_REDIRECT_URI = 'https://<your-host>/auth/callback'
         OAUTH_ISSUE_REFRESH_TOKENS = TRUE
         OAUTH_REFRESH_TOKEN_VALIDITY = 7776000
         ENABLED = TRUE;

       SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('SEMANTICUI_OAUTH');

2. Configure the backend env:

       SEMANTICUI_AUTH_MODE=oauth
       SEMANTICUI_ENVIRONMENT=production
       SEMANTICUI_SECRET_KEY=<32+ bytes of entropy, from a secret store>
       SEMANTICUI_DATABASE_URL=postgresql+psycopg://...
       SEMANTICUI_SNOWFLAKE_ACCOUNT=<orgname-accountname>
       SEMANTICUI_OAUTH_CLIENT_ID=<from step 1>
       SEMANTICUI_OAUTH_CLIENT_SECRET=<from step 1>
       SEMANTICUI_OAUTH_REDIRECT_URI=https://<your-host>/auth/callback

The backend refuses to start with AUTH_MODE=dev in production.

## Tests

    cd backend && pytest              # unit tests (no Snowflake needed)
    pytest -m integration             # real-account tests, needs SEMANTICUI_IT_* env vars
    cd frontend && npm test           # frontend tests

Integration env vars: SEMANTICUI_IT_ACCOUNT, SEMANTICUI_IT_USER,
SEMANTICUI_IT_PASSWORD, optional SEMANTICUI_IT_DATABASE / _SCHEMA / _VIEW.
```

- [ ] **Step 4: Manual end-to-end smoke test (render it and look at it)**

With backend + frontend running and Postgres up:

1. Open http://localhost:5173 -> redirected to the login page.
2. Dev-login with externalbrowser -> browser pops once -> lands on the explorer.
3. The tree shows only semantic views YOUR user can see.
4. Select a view -> dimensions and metrics appear with data types.
5. Check 1 date dimension + 1 metric -> Run -> line chart + table + "SQL sent".
6. Check a text dimension instead -> Run -> bar chart with rounded tops.
7. Check 2 dimensions -> Run -> table only (no chart).
8. Eyeball the chart: no label collisions, axis text is muted gray not series-colored, tooltip appears on hover.
9. Log out -> back to login; /api/me now returns 401.

Fix anything that fails before committing.

- [ ] **Step 5: Run ALL tests one final time**

Run (backend): `pytest -v`
Run (frontend): `npm test`
Expected: everything passes.

- [ ] **Step 6: Commit**

```bash
git add README.md backend/tests/integration
git commit -m "feat: integration suite and setup docs"
```

---

## Done

All 17 tasks complete = sub-project 1 (Foundation) of the 5-part roadmap is
shippable: per-user auth (OAuth + dev mode), per-user connection cache, query
gateway, and the semantic view explorer. Sub-project 2 (report authoring &
saved reports) builds on `users`, `ConnectionProvider`, and the query gateway.
