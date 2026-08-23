"""Engine, declarative base, and the per-request session dependency."""

from collections.abc import Iterator
from datetime import datetime, timezone
from functools import lru_cache

from sqlalchemy import DateTime, create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.types import TypeDecorator

from app.config import get_settings


class UtcDateTime(TypeDecorator):
    """A timestamp that is always UTC-aware in Python, on either database.

    Postgres `timestamptz` hands back an aware datetime. SQLite hands back a
    NAIVE one even for a column declared `DateTime(timezone=True)`, so the
    same code serialized "2026-08-19T15:40:00" in development and
    "...+00:00" in production -- and a browser reads the first as LOCAL
    time. In IST that moved every timestamp five and a half hours, which is
    how a thing that had just happened came to read "5 hours ago".

    The display was the smaller half. A bug that cannot reproduce on the
    database production runs is the kind that costs an afternoon, so this
    exists to make the two dialects agree rather than to format anything.

    Values are normalised to UTC going in and re-tagged as UTC coming out.
    Naive values already in a database were written by `now_utc()` and were
    always UTC in fact, so reading them that way states what was true rather
    than leaving them to mean whatever the reader's zone says.

    The stored column type is unchanged, so this needs no migration.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def process_result_value(self, value: datetime | None, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)


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
