"""certification and ownership for a semantic view

A report shows numbers and nothing said whether the model behind them was
one the organisation stood behind, or who to ask when they looked wrong.

The row is keyed by the view's identity in Snowflake and holds no copy of
its shape: if the view is dropped the record means nothing, which is the
correct outcome rather than a bug.

`certified_by_role` is the column that earns the table. Authority to
certify is Snowflake's answer -- the caller's session must hold the role
that owns the view -- so what is worth keeping is under whose authority
it happened, not merely who clicked.

Revision ID: 0014
Revises: 0013
"""

import sqlalchemy as sa
from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "model_certifications",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("database", sa.String(255), nullable=False),
        sa.Column("schema", sa.String(255), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column(
            "certified", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column(
            "certified_by_user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
        sa.Column("certified_by_role", sa.String(255), nullable=True),
        sa.Column("certified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("owner_name", sa.String(255), nullable=True),
        sa.Column("owner_contact", sa.String(255), nullable=True),
        sa.Column("note", sa.String(1000), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "database", "schema", "name", name="uq_model_certifications_view"
        ),
    )


def downgrade() -> None:
    op.drop_table("model_certifications")
