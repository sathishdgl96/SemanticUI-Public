"""session context and library state

Every column added here is nullable or defaulted, so installing this
migration cannot hide or alter a row written before it.

Revision ID: 0007
Revises: 0006
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("last_role", sa.String(255), nullable=True))
    op.add_column("users", sa.Column("last_warehouse", sa.String(255), nullable=True))
    for table in ("reports", "saved_explores"):
        op.add_column(table, sa.Column("snowflake_role", sa.String(255), nullable=True))
        op.add_column(
            table, sa.Column("snowflake_warehouse", sa.String(255), nullable=True)
        )
    op.create_table(
        "user_item_state",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("item_type", sa.String(16), nullable=False),
        sa.Column("item_id", sa.Uuid(), nullable=False),
        sa.Column("favorite", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("last_viewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint(
            "user_id", "item_type", "item_id", name="uq_user_item_state"
        ),
    )
    op.create_index("ix_user_item_state_user_id", "user_item_state", ["user_id"])
    op.create_index("ix_user_item_state_item_id", "user_item_state", ["item_id"])
    # "What did I open last" is the default sort of every list page.
    op.create_index(
        "ix_user_item_state_recent", "user_item_state", ["user_id", "last_viewed_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_user_item_state_recent", table_name="user_item_state")
    op.drop_index("ix_user_item_state_item_id", table_name="user_item_state")
    op.drop_index("ix_user_item_state_user_id", table_name="user_item_state")
    op.drop_table("user_item_state")
    for table in ("reports", "saved_explores"):
        op.drop_column(table, "snowflake_warehouse")
        op.drop_column(table, "snowflake_role")
    op.drop_column("users", "last_warehouse")
    op.drop_column("users", "last_role")
