"""remember that somebody has been welcomed

Nothing explained the product's shape to a person signing in for the
first time, and the empty states -- which are good -- each teach the next
click rather than the arc.

One nullable timestamp beside the other per-user preferences. NULL means
never welcomed, which is the only state that opens the dialog unprompted;
reopening it from the profile menu deliberately does not clear it, so a
second sign-in is never interrupted because somebody went looking for
help.

Revision ID: 0015
Revises: 0014
"""

import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("welcomed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "welcomed_at")
