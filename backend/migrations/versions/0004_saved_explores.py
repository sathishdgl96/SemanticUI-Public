"""saved explores

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "saved_explores",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "owner_user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "workspace_id",
            sa.Uuid(),
            #: CASCADE, matching reports: deleting a workspace must not leave
            #: rows behind that nobody can reach or delete.
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("view_database", sa.String(255), nullable=False),
        sa.Column("view_schema", sa.String(255), nullable=False),
        sa.Column("view_name", sa.String(255), nullable=False),
        sa.Column("definition", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_saved_explores_owner_user_id", "saved_explores", ["owner_user_id"]
    )
    op.create_index(
        "ix_saved_explores_workspace_id", "saved_explores", ["workspace_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_saved_explores_workspace_id", table_name="saved_explores")
    op.drop_index("ix_saved_explores_owner_user_id", table_name="saved_explores")
    op.drop_table("saved_explores")
