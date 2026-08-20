"""visuals pinned to a user's home page

A widget names a visual inside a report -- it does not copy one. That is
what lets the report stay the single definition of what the visual is,
and what makes losing access to the report lose the widget with it.

`report_id` carries no foreign key for the same reason `user_item_state`
does not: the delete path cleans polymorphic references explicitly, and a
cascade here would be the only one of the three that behaved differently.

Revision ID: 0009
Revises: 0008
"""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "home_widgets",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False, index=True
        ),
        sa.Column("report_id", sa.Uuid(), nullable=False, index=True),
        sa.Column("page_id", sa.String(64), nullable=False),
        sa.Column("visual_id", sa.String(64), nullable=False),
        sa.Column("title", sa.String(200), nullable=True),
        sa.Column("x", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("y", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("w", sa.Integer(), nullable=False, server_default="4"),
        sa.Column("h", sa.Integer(), nullable=False, server_default="4"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        # Pinning the same visual twice would put two identical widgets on
        # the page, and the second one is never what anybody meant.
        sa.UniqueConstraint(
            "user_id", "report_id", "page_id", "visual_id", name="uq_home_widget"
        ),
    )


def downgrade() -> None:
    op.drop_table("home_widgets")
