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
