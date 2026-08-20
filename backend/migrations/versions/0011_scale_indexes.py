"""indexes for the queries the app actually runs

Every index here is named after a query that exists, not a column that
looked important. Written against a 500-user target, where the difference
that matters is not how fast one statement is but whether the planner has
to read rows it will then throw away.

What was missing, and why each one:

* `workspace_members(user_id, workspace_id)` -- "which workspaces am I
  in" runs on every listing, and `membership()` filters on BOTH columns.
  The unique constraint is (workspace_id, user_id), whose leading column
  is the wrong one for that direction, so the lookup fell back to the
  single-column user_id index and then filtered.

* `reports/dashboards/saved_explores (workspace_id, updated_at DESC)` --
  every listing is scoped to a workspace and ordered by updated_at. With
  only workspace_id indexed the rows come back unordered and are sorted
  afterwards, which at a few thousand reports is a sort of the whole
  workspace on every page load.

* `audit_events (action, ts DESC)` and `(user_id, ts DESC)` -- the
  activity log filters by one of those and always orders by ts. The
  single-column indexes serve the filter or the order, never both.

* `audit_events (ts DESC)` already exists and is what the unfiltered log
  and the security window read; it stays.

Revision ID: 0011
Revises: 0010
"""

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

#: (name, table, columns). Descending on the time column because every
#: reader of these wants the newest first, and an index scanned backwards
#: is only free on some engines.
INDEXES = [
    ("ix_workspace_members_user_workspace", "workspace_members", ["user_id", "workspace_id"]),
    ("ix_reports_workspace_updated", "reports", ["workspace_id", "updated_at"]),
    ("ix_dashboards_workspace_updated", "dashboards", ["workspace_id", "updated_at"]),
    ("ix_explores_workspace_updated", "saved_explores", ["workspace_id", "updated_at"]),
    ("ix_audit_action_ts", "audit_events", ["action", "ts"]),
    ("ix_audit_user_ts", "audit_events", ["user_id", "ts"]),
    # "What have I pinned" and "what have I opened" both filter this pair.
    # The unique constraint (user_id, item_type, item_id) covers the
    # prefix, but not with last_viewed_at alongside it.
    ("ix_user_item_state_user_type_seen", "user_item_state", ["user_id", "item_type", "last_viewed_at"]),
]


def upgrade() -> None:
    for name, table, columns in INDEXES:
        op.create_index(name, table, columns)


def downgrade() -> None:
    for name, table, _ in reversed(INDEXES):
        op.drop_index(name, table_name=table)
