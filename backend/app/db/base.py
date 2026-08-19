"""Engine, declarative base, and the per-request session dependency."""

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


def new_session() -> Session:
    """Open a short-lived Session outside of the FastAPI request cycle.

    Used by background tasks (e.g. the connection-cache/session sweeper)
    that need a Session but aren't wired through the get_db dependency.
    Caller is responsible for closing it.
    """
    factory = sessionmaker(bind=get_engine(), expire_on_commit=False)
    return factory()


def get_db() -> Iterator[Session]:
    session = new_session()
    try:
        yield session
    finally:
        session.close()
