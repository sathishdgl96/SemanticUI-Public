"""The 0003 data migration, exercised on a real SQLite file.

The unit suite builds its schema with `Base.metadata.create_all`, which never
runs a migration -- so without this the backfill would stay entirely unverified
until it ran against someone's real database.
"""

import uuid
from datetime import datetime, timezone

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config


@pytest.fixture
def alembic_config(tmp_path):
    url = f"sqlite:///{tmp_path / 'migrate.db'}"
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", url)
    return config, url


def _seed(url, rows):
    """Insert users and their reports at revision 0002."""
    engine = sa.create_engine(url)
    meta = sa.MetaData()
    # Same reason as the migration: SQLite reflects a sa.Uuid column as
    # CHAR(32), which will not bind a Python uuid.UUID.
    users = sa.Table("users", meta, sa.Column("id", sa.Uuid(), primary_key=True), autoload_with=engine)
    reports = sa.Table(
        "reports",
        meta,
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("owner_user_id", sa.Uuid()),
        autoload_with=engine,
    )
    now = datetime.now(timezone.utc)
    with engine.begin() as conn:
        for user_id, account, username, report_names in rows:
            conn.execute(
                users.insert().values(
                    id=user_id,
                    snowflake_account=account,
                    snowflake_user=username,
                    created_at=now,
                )
            )
            for name in report_names:
                conn.execute(
                    reports.insert().values(
                        id=uuid.uuid4(),
                        owner_user_id=user_id,
                        name=name,
                        view_database="D",
                        view_schema="S",
                        view_name="V",
                        definition={},
                        created_at=now,
                        updated_at=now,
                    )
                )
    engine.dispose()


def test_existing_reports_land_in_their_owners_personal_workspace(alembic_config):
    config, url = alembic_config
    command.upgrade(config, "0002")
    alice, bob = uuid.uuid4(), uuid.uuid4()
    _seed(
        url,
        [
            (alice, "ACME", "ALICE", ["A1", "A2"]),
            (bob, "ACME", "BOB", ["B1"]),
        ],
    )

    command.upgrade(config, "0003")

    engine = sa.create_engine(url)
    with engine.connect() as conn:
        rows = conn.execute(
            sa.text(
                "SELECT r.name, w.id, w.kind, m.role, u.snowflake_user, w.name "
                "FROM reports r "
                "JOIN workspaces w ON w.id = r.workspace_id "
                "JOIN workspace_members m ON m.workspace_id = w.id "
                "JOIN users u ON u.id = m.user_id "
                "ORDER BY r.name"
            )
        ).fetchall()
    engine.dispose()

    assert len(rows) == 3, "every report must land in exactly one workspace"
    by_report = {row[0]: row for row in rows}
    # Compared by workspace ID, not name: every personal workspace is called
    # "My reports", so comparing names would pass even if all three reports
    # had been dumped into a single shared workspace.
    assert by_report["A1"][1] == by_report["A2"][1]
    assert by_report["A1"][1] != by_report["B1"][1]
    assert by_report["A1"][5] == "My reports"
    for row in rows:
        assert row[2] == "personal"
        assert row[3] == "admin", "the owner must administer their own workspace"
    assert by_report["A1"][4] == "ALICE"
    assert by_report["B1"][4] == "BOB"


def test_workspace_id_is_not_null_after_the_migration(alembic_config):
    config, url = alembic_config
    command.upgrade(config, "0003")
    engine = sa.create_engine(url)
    reports = sa.Table("reports", sa.MetaData(), autoload_with=engine)
    nullable = reports.c.workspace_id.nullable
    engine.dispose()
    assert nullable is False


def test_the_migration_is_reversible(alembic_config):
    """A migration you cannot roll back is one you cannot deploy carefully."""
    config, url = alembic_config
    command.upgrade(config, "0003")
    command.downgrade(config, "0002")
    engine = sa.create_engine(url)
    inspector = sa.inspect(engine)
    tables = inspector.get_table_names()
    report_columns = [c["name"] for c in inspector.get_columns("reports")]
    engine.dispose()
    assert "workspaces" not in tables
    assert "workspace_members" not in tables
    assert "workspace_id" not in report_columns


def test_a_workspace_carries_its_owners_snowflake_account(alembic_config):
    """Membership is confined to one account, so the workspace records which."""
    config, url = alembic_config
    command.upgrade(config, "0002")
    _seed(url, [(uuid.uuid4(), "XRIIEIM", "ALICE", ["A1"])])

    command.upgrade(config, "0003")

    engine = sa.create_engine(url)
    with engine.connect() as conn:
        account = conn.execute(sa.text("SELECT snowflake_account FROM workspaces")).scalar()
    engine.dispose()
    assert account == "XRIIEIM"


def test_a_user_who_owns_nothing_gets_no_workspace_from_the_migration(alembic_config):
    """Personal workspaces are created lazily on login for everyone else, so
    the migration must not manufacture one for a user with no reports."""
    config, url = alembic_config
    command.upgrade(config, "0002")
    _seed(url, [(uuid.uuid4(), "ACME", "IDLE", [])])

    command.upgrade(config, "0003")

    engine = sa.create_engine(url)
    with engine.connect() as conn:
        count = conn.execute(sa.text("SELECT COUNT(*) FROM workspaces")).scalar()
    engine.dispose()
    assert count == 0


def test_migrating_an_empty_database_succeeds(alembic_config):
    """A fresh install has no users and no reports; the backfill must be a
    no-op rather than an error."""
    config, url = alembic_config
    command.upgrade(config, "0003")
    engine = sa.create_engine(url)
    with engine.connect() as conn:
        assert conn.execute(sa.text("SELECT COUNT(*) FROM workspaces")).scalar() == 0
    engine.dispose()
