"""remember which account a session chose at login

Without this the connection cache rebuilds an expired OAuth connection
against the DEFAULT account, because the choice lived only in the
short-lived OAuth state. In a multi-account deployment the same IdP app
is typically trusted by every account, so the rebuild succeeds -- and
the user silently runs against an account they did not pick.

Revision ID: 0008
Revises: 0007
"""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("snowflake_account_choice", sa.String(255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sessions", "snowflake_account_choice")
