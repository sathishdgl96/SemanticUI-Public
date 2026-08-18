"""connect tokens for Excel / Power Query

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("connect_token_hash", sa.String(64), nullable=True),
    )
    op.add_column(
        "sessions",
        sa.Column("connect_token_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_sessions_connect_token_hash", "sessions", ["connect_token_hash"]
    )


def downgrade() -> None:
    op.drop_index("ix_sessions_connect_token_hash", table_name="sessions")
    op.drop_column("sessions", "connect_token_expires_at")
    op.drop_column("sessions", "connect_token_hash")
