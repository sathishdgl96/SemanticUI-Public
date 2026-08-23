"""announcements as their own object

They lived as a field on a dashboard's document, which made a broadcast
to the whole deployment something you had to open one dashboard to read
-- and made writing one a thing any workspace editor could do.

Its own table, and its own gate: the admin list in the environment. A
notice shown to every user is not a permission any row in this database
should be able to grant.

The dashboard field is left where it is. It is inside a JSON document,
so nothing needs to be dropped, and a document written before this still
parses -- the schema simply stopped offering the key.

Revision ID: 0012
Revises: 0011
"""

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "announcements",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("message", sa.String(500), nullable=False),
        sa.Column("level", sa.String(16), nullable=False, server_default="info"),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_announcements_active_starts", "announcements", ["active", "starts_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_announcements_active_starts", table_name="announcements")
    op.drop_table("announcements")
