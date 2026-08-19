import os

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


from fastapi.testclient import TestClient

from app.auth import throttle
from app.config import Settings, get_settings
from app.db.base import get_db
from app.main import create_app
from app.snowflake import provider
from app.xmla import state as xmla_state


@pytest.fixture(autouse=True)
def isolate_settings_from_local_config(monkeypatch):
    """A developer's backend/.env must never decide a test's result.

    `Settings` reads `env_file=".env"`, so whatever happens to be
    configured locally -- an IdP, a database URL, a branded app name --
    silently becomes the environment every test runs in. The suite then
    passes on one machine and fails on another, and CI (which has no
    .env) agrees with neither. Caught the day a real OAUTH_AUTHORIZE_URL
    landed in .env and 25 unrelated tests started failing.

    Tests declare the environment they need, explicitly, via make_client.
    SEMANTICUI_IT_* is left alone: the integration suite reads those from
    os.environ by design (see tests/integration/conftest.py).
    """
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    for key in [
        k for k in os.environ
        if k.startswith("SEMANTICUI_") and not k.startswith("SEMANTICUI_IT_")
    ]:
        monkeypatch.delenv(key, raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def make_client(db_factory, monkeypatch):
    def _make(**env) -> TestClient:
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        get_settings.cache_clear()
        provider.reset_cache()
        throttle.reset_window()
        xmla_state.reset_store()
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
