"""composite semantic models

One model over several Snowflake semantic views. A workspace-owned
document naming member views and the conformed dimensions that make them
joinable -- the same shape a report or dashboard has, and governed by the
same membership rule.

A document rather than tables for members and shared dimensions: a
composite is edited and saved as one thing, and half a saved mapping is
not a state worth being able to reach. The same reasoning as a report's
visuals and a dashboard's tiles.

Nothing is written to Snowflake by this migration or by anything the
object does today. The definition lives here; queries compose it at run
time on the caller's own connection.

Revision ID: 0013
Revises: 0012
"""

import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "composite_models",
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
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("definition", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_composite_models_owner_user_id", "composite_models", ["owner_user_id"]
    )
    op.create_index(
        "ix_composite_models_workspace_id", "composite_models", ["workspace_id"]
    )
    # The listing's only ordering, matching the other three kinds: browse
    # reads one workspace newest-first.
    op.create_index(
        "ix_composite_models_workspace_updated",
        "composite_models",
        ["workspace_id", "updated_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_composite_models_workspace_updated", table_name="composite_models"
    )
    op.drop_index("ix_composite_models_workspace_id", table_name="composite_models")
    op.drop_index("ix_composite_models_owner_user_id", table_name="composite_models")
    op.drop_table("composite_models")
