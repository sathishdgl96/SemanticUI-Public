"""workspaces and sharing

Revision ID: 0003
Revises: 0002
"""

import uuid
from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workspaces",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("snowflake_account", sa.String(255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "workspace_members",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.Uuid(),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("workspace_id", "user_id", name="uq_workspace_members"),
    )
    op.create_index(
        "ix_workspace_members_workspace_id", "workspace_members", ["workspace_id"]
    )
    op.create_index("ix_workspace_members_user_id", "workspace_members", ["user_id"])

    # Nullable first: existing rows have nothing to put here yet.
    op.add_column("reports", sa.Column("workspace_id", sa.Uuid(), nullable=True))

    _backfill_personal_workspaces()

    # SQLite cannot ALTER a column in place, so batch mode rebuilds the table.
    # Postgres ignores the batching and issues a plain ALTER.
    with op.batch_alter_table("reports") as batch:
        batch.alter_column("workspace_id", existing_type=sa.Uuid(), nullable=False)
    op.create_index("ix_reports_workspace_id", "reports", ["workspace_id"])


def _backfill_personal_workspaces() -> None:
    """Give every user who already owns reports a personal workspace.

    Only those users: personal workspaces are created lazily on login for
    everyone else, so manufacturing one here for a user with no reports would
    hand them something they may never use.

    Reflected tables rather than raw SQL text, because `sa.Uuid` stores as
    CHAR(32) on SQLite and as a native UUID on Postgres -- only the real column
    type binds a Python `uuid.UUID` correctly on both.
    """
    bind = op.get_bind()
    meta = sa.MetaData()
    # The UUID columns are declared explicitly rather than left to reflection.
    # SQLite reports them as CHAR(32), and binding a Python uuid.UUID against a
    # plain String raises "type 'UUID' is not supported" -- so reflection alone
    # produces a migration that works on Postgres and dies on SQLite.
    users = sa.Table("users", meta, sa.Column("id", sa.Uuid(), primary_key=True), autoload_with=bind)
    reports = sa.Table(
        "reports",
        meta,
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("owner_user_id", sa.Uuid()),
        sa.Column("workspace_id", sa.Uuid()),
        autoload_with=bind,
    )
    workspaces = sa.Table(
        "workspaces", meta, sa.Column("id", sa.Uuid(), primary_key=True), autoload_with=bind
    )
    members = sa.Table(
        "workspace_members",
        meta,
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("workspace_id", sa.Uuid()),
        sa.Column("user_id", sa.Uuid()),
        autoload_with=bind,
    )

    owners = bind.execute(
        sa.select(reports.c.owner_user_id, users.c.snowflake_account)
        .select_from(reports.join(users, users.c.id == reports.c.owner_user_id))
        .distinct()
    ).fetchall()

    now = datetime.now(timezone.utc)
    for owner_id, account in owners:
        workspace_id = uuid.uuid4()
        bind.execute(
            workspaces.insert().values(
                id=workspace_id,
                name="My reports",
                kind="personal",
                snowflake_account=account,
                created_at=now,
            )
        )
        bind.execute(
            members.insert().values(
                id=uuid.uuid4(),
                workspace_id=workspace_id,
                user_id=owner_id,
                # The owner administers their own workspace, so the role
                # ladder has a top rung even in a workspace of one.
                role="admin",
                created_at=now,
            )
        )
        bind.execute(
            reports.update()
            .where(reports.c.owner_user_id == owner_id)
            .values(workspace_id=workspace_id)
        )


def downgrade() -> None:
    op.drop_index("ix_reports_workspace_id", table_name="reports")
    with op.batch_alter_table("reports") as batch:
        batch.drop_column("workspace_id")
    op.drop_index("ix_workspace_members_user_id", table_name="workspace_members")
    op.drop_index("ix_workspace_members_workspace_id", table_name="workspace_members")
    op.drop_table("workspace_members")
    op.drop_table("workspaces")
