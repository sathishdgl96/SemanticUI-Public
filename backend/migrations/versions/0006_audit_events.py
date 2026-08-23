"""audit events

Revision ID: 0006
Revises: 0005
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("request_id", sa.String(64), nullable=True),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("session_ref", sa.String(16), nullable=True),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("resource_type", sa.String(32), nullable=True),
        sa.Column("resource_id", sa.String(64), nullable=True),
        sa.Column("outcome", sa.String(16), nullable=False),
        sa.Column("detail", sa.JSON(), nullable=True),
    )
    op.create_index("ix_audit_events_ts", "audit_events", ["ts"])
    op.create_index("ix_audit_events_user_id", "audit_events", ["user_id"])
    op.create_index("ix_audit_events_action", "audit_events", ["action"])


def downgrade() -> None:
    op.drop_index("ix_audit_events_action", table_name="audit_events")
    op.drop_index("ix_audit_events_user_id", table_name="audit_events")
    op.drop_index("ix_audit_events_ts", table_name="audit_events")
    op.drop_table("audit_events")
