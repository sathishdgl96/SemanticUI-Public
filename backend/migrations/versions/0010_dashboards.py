"""dashboards: visuals from several reports on one workspace canvas

Replaces the personal `home_widgets` table from 0009. A pinned visual is
not a private bookmark -- it is a thing a team looks at together -- so it
belongs to a workspace and is governed by the same membership rule as the
reports it draws from.

`home_widgets` is dropped rather than migrated. It shipped in the same
development cycle and holds only each developer's own pins; carrying them
into a shared object would have meant inventing a workspace and a
dashboard name on every user's behalf.

Revision ID: 0010
Revises: 0009
"""

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "dashboards",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "owner_user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "workspace_id",
            sa.Uuid(),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("definition", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    # No foreign key: a chosen dashboard may be deleted, or the chooser may
    # lose access to its workspace. Both resolve to "no dashboard chosen"
    # when Home is read, which a cascade or a constraint would turn into an
    # error instead.
    op.add_column(
        "users", sa.Column("home_dashboard_id", sa.Uuid(), nullable=True)
    )

    op.drop_table("home_widgets")


def downgrade() -> None:
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
        sa.UniqueConstraint(
            "user_id", "report_id", "page_id", "visual_id", name="uq_home_widget"
        ),
    )
    op.drop_column("users", "home_dashboard_id")
    op.drop_table("dashboards")
