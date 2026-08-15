"""reports

Revision ID: 0002
Revises: 0001
"""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "reports",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("owner_user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("view_database", sa.String(255), nullable=False),
        sa.Column("view_schema", sa.String(255), nullable=False),
        sa.Column("view_name", sa.String(255), nullable=False),
        sa.Column("definition", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_reports_owner_user_id", "reports", ["owner_user_id"])


def downgrade() -> None:
    op.drop_index("ix_reports_owner_user_id", table_name="reports")
    op.drop_table("reports")
