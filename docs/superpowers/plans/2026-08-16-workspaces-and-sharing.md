# Workspaces & Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user share reports with colleagues through workspaces, while every viewer's queries keep running on their own Snowflake credentials.

**Architecture:** Two new tables (`workspaces`, `workspace_members`) and one new non-null column (`reports.workspace_id`). A single function, `require_access`, replaces `get_owned_report` on every report route and resolves report → workspace → membership. Sharing moves report *definitions* between people; data access stays entirely Snowflake's business, because every query still runs on the requesting session's own connection.

**Tech Stack:** FastAPI + pydantic v2 + SQLAlchemy 2.0 + Alembic (backend), React 18 + TypeScript + TanStack Query (frontend), pytest, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-16-workspaces-and-sharing-design.md`

## Global Constraints

Copied from the spec. Every task's requirements implicitly include this section.

- **Sharing shares report definitions. It never shares data.** Every query runs on `entry.conn`, the requesting session's own Snowflake connection. No service account, no stored result set, no cross-user cache.
- **A non-member gets 404, never 403.** They must not learn that an id exists. A member with too low a role gets 403, because by then they already know it does.
- **Role order is `viewer < editor < admin`**, expressed once and never re-derived.
- **The last admin cannot be removed or demoted**, including by themselves.
- **Personal workspaces refuse members, renames and deletion.**
- **Membership is confined to one Snowflake account.**
- **Moving a report requires editor on both source and destination.**
- **Deleting a workspace deletes its reports** (cascade), and the UI names the count first.
- Backend endpoints are sync `def` (not `async def`), matching every existing route.
- Frontend: run `npm run typecheck` (`tsc -b`). Bare `tsc --noEmit` checks **nothing** — the root tsconfig is solution-style with `"files": []`.
- Existing UI constraints carry over: drag is never the only path, focus outlines are never removed, hit targets clear 24px, chrome is never painted in a series colour, and the layout holds at 1440 / 1280 / 1024 / 768 / 390px.
- **Never modify or reorder `frontend/src/query/palette.ts`.**

## File Structure

**Backend — created:**
- `app/workspaces/__init__.py`
- `app/workspaces/roles.py` — the role ordering, and nothing else.
- `app/workspaces/access.py` — `require_workspace` and `require_access`. The only place an authorization decision is made.
- `app/workspaces/service.py` — workspace and membership CRUD, including the guard rails.
- `app/workspaces/routes.py` — the HTTP surface.
- `migrations/versions/0003_workspaces.py`

**Backend — modified:**
- `app/db/models.py` — `Workspace`, `WorkspaceMember`, `Report.workspace_id`.
- `app/auth/sessions.py` — ensure a personal workspace on login.
- `app/reports/routes.py` — every route switches to `require_access`.
- `app/reports/service.py` — `get_owned_report` is removed; create/import take a workspace.
- `app/main.py` — register the workspace router.

**Frontend — created:**
- `src/api/workspaces.ts`, `src/workspaces/WorkspaceSwitcher.tsx`, `src/workspaces/MembersPanel.tsx`, `src/workspaces/useWorkspaces.ts`

**Frontend — modified:**
- `src/api/types.ts`, `src/api/reports.ts`, `src/reports/ReportListPage.tsx`, `src/reports/BuilderPage.tsx`, `src/index.css`

---

## Task 1: Tables and the data migration

**Files:**
- Modify: `backend/app/db/models.py`
- Create: `backend/migrations/versions/0003_workspaces.py`
- Test: `backend/tests/test_models.py`, `backend/tests/test_migration_0003.py`

**Interfaces:**
- Produces: `Workspace(id, name, kind, snowflake_account, created_at)`, `WorkspaceMember(id, workspace_id, user_id, role, created_at)`, `Report.workspace_id`

- [ ] **Step 1: Write the failing model test**

Append to `backend/tests/test_models.py`:

```python
from app.db.models import Report, User, Workspace, WorkspaceMember


def test_a_workspace_holds_members_with_roles(db):
    user = User(snowflake_account="ACME", snowflake_user="ALICE")
    db.add(user)
    db.flush()
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=user.id, role="admin"))
    db.commit()

    found = db.query(WorkspaceMember).one()
    assert found.role == "admin"
    assert found.workspace_id == ws.id


def test_a_user_cannot_be_added_to_the_same_workspace_twice(db):
    from sqlalchemy.exc import IntegrityError

    user = User(snowflake_account="ACME", snowflake_user="ALICE")
    db.add(user)
    db.flush()
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=user.id, role="admin"))
    db.commit()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=user.id, role="viewer"))
    with pytest.raises(IntegrityError):
        db.commit()


def test_a_report_belongs_to_a_workspace(db):
    user = User(snowflake_account="ACME", snowflake_user="ALICE")
    db.add(user)
    db.flush()
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    report = Report(
        owner_user_id=user.id, workspace_id=ws.id, name="R",
        view_database="D", view_schema="S", view_name="V", definition={},
    )
    db.add(report)
    db.commit()
    assert db.query(Report).one().workspace_id == ws.id
```

Add `import pytest` at the top of the file if it is not already there.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_models.py -v`
Expected: FAIL — `ImportError: cannot import name 'Workspace'`

- [ ] **Step 3: Add the models**

In `backend/app/db/models.py`, after `DbSession` and before `Report`:

```python
class Workspace(Base):
    __tablename__ = "workspaces"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200))
    #: "personal" or "shared". A personal workspace refuses members, renames
    #: and deletion -- that is what distinguishes "my drafts" from a shared
    #: workspace that happens to have one member today.
    kind: Mapped[str] = mapped_column(String(16), default="shared")
    #: Membership is confined to this Snowflake account: a user from another
    #: account could never resolve the views these reports bind to, so the
    #: grant would be an illusion of access.
    snowflake_account: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class WorkspaceMember(Base):
    __tablename__ = "workspace_members"
    __table_args__ = (
        UniqueConstraint("workspace_id", "user_id", name="uq_workspace_members"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    #: Indexed because "which workspaces am I in" runs on every report list.
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    role: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
```

On `Report`, after `owner_user_id`:

```python
    #: The access boundary. `owner_user_id` above is now provenance only --
    #: who created this -- and is never consulted for authorization.
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_models.py -v`
Expected: PASS

- [ ] **Step 5: Write the failing migration test**

```python
# backend/tests/test_migration_0003.py
"""The 0003 data migration, exercised on a real SQLite file.

The unit suite builds its schema with `Base.metadata.create_all`, which never
runs a migration -- so without this test the backfill would be entirely
unverified until it ran against someone's production database.
"""
import uuid
from datetime import datetime, timezone

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config


@pytest.fixture
def alembic_config(tmp_path):
    url = f"sqlite:///{tmp_path / 'migrate.db'}"
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", url)
    return config, url


def test_existing_reports_land_in_their_owners_personal_workspace(alembic_config):
    config, url = alembic_config
    command.upgrade(config, "0002")

    engine = sa.create_engine(url)
    users = sa.Table("users", sa.MetaData(), autoload_with=engine)
    reports = sa.Table("reports", sa.MetaData(), autoload_with=engine)
    alice, bob = uuid.uuid4(), uuid.uuid4()
    now = datetime.now(timezone.utc)
    with engine.begin() as conn:
        conn.execute(users.insert(), [
            {"id": alice, "snowflake_account": "ACME", "snowflake_user": "ALICE",
             "created_at": now},
            {"id": bob, "snowflake_account": "ACME", "snowflake_user": "BOB",
             "created_at": now},
        ])
        conn.execute(reports.insert(), [
            {"id": uuid.uuid4(), "owner_user_id": alice, "name": "A1",
             "view_database": "D", "view_schema": "S", "view_name": "V",
             "definition": {}, "created_at": now, "updated_at": now},
            {"id": uuid.uuid4(), "owner_user_id": alice, "name": "A2",
             "view_database": "D", "view_schema": "S", "view_name": "V",
             "definition": {}, "created_at": now, "updated_at": now},
            {"id": uuid.uuid4(), "owner_user_id": bob, "name": "B1",
             "view_database": "D", "view_schema": "S", "view_name": "V",
             "definition": {}, "created_at": now, "updated_at": now},
        ])

    command.upgrade(config, "0003")

    engine = sa.create_engine(url)
    with engine.connect() as conn:
        rows = conn.execute(sa.text(
            "SELECT r.name, w.name, w.kind, m.role, u.snowflake_user "
            "FROM reports r "
            "JOIN workspaces w ON w.id = r.workspace_id "
            "JOIN workspace_members m ON m.workspace_id = w.id "
            "JOIN users u ON u.id = m.user_id "
            "ORDER BY r.name"
        )).fetchall()

    assert len(rows) == 3, "every report must land in exactly one workspace"
    by_report = {r[0]: r for r in rows}
    # Alice's two reports share one personal workspace; Bob's is separate.
    assert by_report["A1"][1] == by_report["A2"][1]
    assert by_report["A1"][1] != by_report["B1"][1]
    for row in rows:
        assert row[2] == "personal"
        assert row[3] == "admin", "the owner must administer their own workspace"
    assert by_report["A1"][4] == "ALICE"
    assert by_report["B1"][4] == "BOB"


def test_workspace_id_is_not_null_after_the_migration(alembic_config):
    config, url = alembic_config
    command.upgrade(config, "0003")
    engine = sa.create_engine(url)
    reports = sa.Table("reports", sa.MetaData(), autoload_with=engine)
    assert reports.c.workspace_id.nullable is False


def test_the_migration_is_reversible(alembic_config):
    """A migration you cannot roll back is a migration you cannot deploy
    carefully."""
    config, url = alembic_config
    command.upgrade(config, "0003")
    command.downgrade(config, "0002")
    engine = sa.create_engine(url)
    inspector = sa.inspect(engine)
    assert "workspaces" not in inspector.get_table_names()
    assert "workspace_id" not in [c["name"] for c in inspector.get_columns("reports")]


def test_a_workspace_carries_its_owners_snowflake_account(alembic_config):
    """Membership is confined to one account, so the workspace has to record
    which one it belongs to."""
    config, url = alembic_config
    command.upgrade(config, "0002")
    engine = sa.create_engine(url)
    users = sa.Table("users", sa.MetaData(), autoload_with=engine)
    reports = sa.Table("reports", sa.MetaData(), autoload_with=engine)
    alice = uuid.uuid4()
    now = datetime.now(timezone.utc)
    with engine.begin() as conn:
        conn.execute(users.insert(), [
            {"id": alice, "snowflake_account": "XRIIEIM", "snowflake_user": "ALICE",
             "created_at": now},
        ])
        conn.execute(reports.insert(), [
            {"id": uuid.uuid4(), "owner_user_id": alice, "name": "A1",
             "view_database": "D", "view_schema": "S", "view_name": "V",
             "definition": {}, "created_at": now, "updated_at": now},
        ])

    command.upgrade(config, "0003")
    engine = sa.create_engine(url)
    with engine.connect() as conn:
        account = conn.execute(
            sa.text("SELECT snowflake_account FROM workspaces")
        ).scalar()
    assert account == "XRIIEIM"
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_migration_0003.py -v`
Expected: FAIL — `Can't locate revision identified by '0003'`

- [ ] **Step 7: Write the migration**

```python
# backend/migrations/versions/0003_workspaces.py
"""workspaces and sharing

Revision ID: 0003
Revises: 0002
"""
import uuid
from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workspaces",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("snowflake_account", sa.String(255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "workspace_members",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.Uuid(),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("workspace_id", "user_id", name="uq_workspace_members"),
    )
    op.create_index(
        "ix_workspace_members_workspace_id", "workspace_members", ["workspace_id"]
    )
    op.create_index("ix_workspace_members_user_id", "workspace_members", ["user_id"])

    # Nullable first: existing rows have nothing to put here yet.
    op.add_column("reports", sa.Column("workspace_id", sa.Uuid(), nullable=True))

    _backfill_personal_workspaces()

    # SQLite cannot ALTER a column in place, so batch mode rebuilds the table.
    # Postgres ignores the batching and issues a plain ALTER.
    with op.batch_alter_table("reports") as batch:
        batch.alter_column("workspace_id", existing_type=sa.Uuid(), nullable=False)
    op.create_index("ix_reports_workspace_id", "reports", ["workspace_id"])


def _backfill_personal_workspaces() -> None:
    """Give every user who already owns reports a personal workspace.

    Reflected tables rather than raw SQL text: `sa.Uuid` stores as CHAR(32) on
    SQLite and as a native UUID on Postgres, and only the real column type
    binds a Python `uuid.UUID` correctly on both.
    """
    bind = op.get_bind()
    meta = sa.MetaData()
    users = sa.Table("users", meta, autoload_with=bind)
    reports = sa.Table("reports", meta, autoload_with=bind)
    workspaces = sa.Table("workspaces", meta, autoload_with=bind)
    members = sa.Table("workspace_members", meta, autoload_with=bind)

    owners = bind.execute(
        sa.select(reports.c.owner_user_id, users.c.snowflake_account)
        .select_from(reports.join(users, users.c.id == reports.c.owner_user_id))
        .distinct()
    ).fetchall()

    now = datetime.now(timezone.utc)
    for owner_id, account in owners:
        workspace_id = uuid.uuid4()
        bind.execute(
            workspaces.insert().values(
                id=workspace_id,
                name="My reports",
                kind="personal",
                snowflake_account=account,
                created_at=now,
            )
        )
        bind.execute(
            members.insert().values(
                id=uuid.uuid4(),
                workspace_id=workspace_id,
                user_id=owner_id,
                # The owner administers their own workspace, so the role
                # ladder has a top rung even for a workspace of one.
                role="admin",
                created_at=now,
            )
        )
        bind.execute(
            reports.update()
            .where(reports.c.owner_user_id == owner_id)
            .values(workspace_id=workspace_id)
        )


def downgrade() -> None:
    op.drop_index("ix_reports_workspace_id", table_name="reports")
    with op.batch_alter_table("reports") as batch:
        batch.drop_column("workspace_id")
    op.drop_index("ix_workspace_members_user_id", table_name="workspace_members")
    op.drop_index("ix_workspace_members_workspace_id", table_name="workspace_members")
    op.drop_table("workspace_members")
    op.drop_table("workspaces")
```

- [ ] **Step 8: Run it to verify it passes**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_migration_0003.py -v`
Expected: PASS (4 tests)

If `Config("alembic.ini")` cannot find the file, the test is being run from the repo root rather than `backend/`; the existing suite is always run from `backend/`, so keep that and do not add path juggling.

- [ ] **Step 9: Run the whole backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`
Expected: FAIL — every existing test that builds a `Report` now violates a NOT NULL `workspace_id`. That is the point of the column; fix them in Task 2 once there is a helper to create a workspace, rather than scattering fixture edits here.

- [ ] **Step 10: Commit**

```bash
git add backend/app/db/models.py backend/migrations/versions/0003_workspaces.py backend/tests/test_models.py backend/tests/test_migration_0003.py
git commit -m "feat: workspace and membership tables, with a backfill migration"
```

---

## Task 2: Roles, access checks, and a personal workspace on login

**Files:**
- Create: `backend/app/workspaces/__init__.py`, `backend/app/workspaces/roles.py`, `backend/app/workspaces/access.py`, `backend/app/workspaces/service.py`
- Modify: `backend/app/auth/sessions.py`, `backend/tests/conftest.py`
- Test: `backend/tests/test_workspace_access.py`

**Interfaces:**
- Consumes: `Workspace`, `WorkspaceMember`, `Report`, `ApiError`
- Produces:
  - `roles.ROLES = ("viewer", "editor", "admin")`, `roles.rank(role) -> int`, `roles.at_least(actual, need) -> bool`
  - `access.membership(db, user_id, workspace_id) -> WorkspaceMember | None`
  - `access.require_workspace(db, user_id, workspace_id, *, need) -> Workspace`
  - `access.require_access(db, user_id, report_id, *, need) -> Report`
  - `service.ensure_personal_workspace(db, user) -> Workspace`

- [ ] **Step 1: Write the failing role test**

```python
# backend/tests/test_workspace_access.py
import uuid

import pytest

from app.db.models import Report, User, Workspace, WorkspaceMember
from app.errors import ApiError
from app.workspaces import roles
from app.workspaces.access import membership, require_access, require_workspace


class TestRoleOrder:
    def test_the_ladder_runs_viewer_editor_admin(self):
        assert roles.ROLES == ("viewer", "editor", "admin")

    def test_a_role_satisfies_itself(self):
        for role in roles.ROLES:
            assert roles.at_least(role, role) is True

    def test_a_higher_role_satisfies_a_lower_requirement(self):
        assert roles.at_least("admin", "viewer") is True
        assert roles.at_least("editor", "viewer") is True

    def test_a_lower_role_does_not_satisfy_a_higher_requirement(self):
        assert roles.at_least("viewer", "editor") is False
        assert roles.at_least("editor", "admin") is False

    def test_an_unknown_role_satisfies_nothing(self):
        """A row with a garbage role must fail closed, not compare as greater
        than everything."""
        assert roles.at_least("superuser", "viewer") is False
        assert roles.at_least("", "viewer") is False


@pytest.fixture
def world(db):
    """Alice admins a shared workspace holding one report. Bob is outside it."""
    alice = User(snowflake_account="ACME", snowflake_user="ALICE")
    bob = User(snowflake_account="ACME", snowflake_user="BOB")
    db.add_all([alice, bob])
    db.flush()
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=alice.id, role="admin"))
    report = Report(
        owner_user_id=alice.id, workspace_id=ws.id, name="R",
        view_database="D", view_schema="S", view_name="V", definition={},
    )
    db.add(report)
    db.commit()
    return {"alice": alice, "bob": bob, "ws": ws, "report": report}


class TestRequireAccess:
    def test_a_member_with_a_sufficient_role_gets_the_report(self, db, world):
        got = require_access(db, world["alice"].id, str(world["report"].id), need="editor")
        assert got.id == world["report"].id

    def test_a_non_member_gets_404_not_403(self, db, world):
        """404, so a stranger cannot distinguish "does not exist" from "exists
        and is not yours" -- the same rule the owner-scoped code followed."""
        with pytest.raises(ApiError) as exc:
            require_access(db, world["bob"].id, str(world["report"].id), need="viewer")
        assert exc.value.status == 404

    def test_a_member_with_too_low_a_role_gets_403(self, db, world):
        """403 rather than 404: they are a member, so they already know it
        exists, and an honest error is more useful than a misleading one."""
        db.add(
            WorkspaceMember(
                workspace_id=world["ws"].id, user_id=world["bob"].id, role="viewer"
            )
        )
        db.commit()
        with pytest.raises(ApiError) as exc:
            require_access(db, world["bob"].id, str(world["report"].id), need="editor")
        assert exc.value.status == 403
        assert exc.value.code == "WORKSPACE_FORBIDDEN"
        assert "editor" in exc.value.message

    def test_a_missing_report_is_404(self, db, world):
        with pytest.raises(ApiError) as exc:
            require_access(db, world["alice"].id, str(uuid.uuid4()), need="viewer")
        assert exc.value.status == 404

    def test_a_malformed_report_id_is_404_not_a_crash(self, db, world):
        with pytest.raises(ApiError) as exc:
            require_access(db, world["alice"].id, "not-a-uuid", need="viewer")
        assert exc.value.status == 404


class TestRequireWorkspace:
    def test_a_member_gets_the_workspace(self, db, world):
        got = require_workspace(db, world["alice"].id, str(world["ws"].id), need="admin")
        assert got.id == world["ws"].id

    def test_a_non_member_gets_404(self, db, world):
        with pytest.raises(ApiError) as exc:
            require_workspace(db, world["bob"].id, str(world["ws"].id), need="viewer")
        assert exc.value.status == 404


def test_membership_returns_none_for_a_non_member(db, world):
    assert membership(db, world["bob"].id, world["ws"].id) is None
    assert membership(db, world["alice"].id, world["ws"].id).role == "admin"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_workspace_access.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.workspaces'`

- [ ] **Step 3: Write the roles module**

```python
# backend/app/workspaces/roles.py
"""The role ladder, expressed once.

Scattering `role == "admin" or role == "editor"` comparisons across routes is
how authorization drifts. Everything that needs to compare two roles calls
`at_least`.
"""

#: Ordered weakest to strongest. Index IS the rank.
ROLES = ("viewer", "editor", "admin")


def rank(role: str) -> int:
    """Position in the ladder, or -1 for anything unrecognised."""
    try:
        return ROLES.index(role)
    except ValueError:
        return -1


def at_least(actual: str, need: str) -> bool:
    """Does `actual` meet or exceed `need`?

    Fails closed on an unknown role: a garbage value in the column compares as
    -1 and therefore satisfies nothing, rather than sorting above every real
    role as a naive string comparison would.
    """
    actual_rank, need_rank = rank(actual), rank(need)
    return actual_rank >= 0 and need_rank >= 0 and actual_rank >= need_rank
```

- [ ] **Step 4: Write the access module**

```python
# backend/app/workspaces/access.py
"""The only place an authorization decision is made.

Two rules, and they differ deliberately:

  * No membership at all -> 404. A non-member must not be able to tell
    "does not exist" from "exists and is not yours".
  * Membership with too low a role -> 403. They already know it exists, so a
    404 here would be a lie that helps nobody.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Report, Workspace, WorkspaceMember
from app.errors import ApiError
from app.workspaces.roles import at_least


def _not_found() -> ApiError:
    return ApiError("HTTP_ERROR", 404, "Not found")


def _forbidden(need: str, actual: str) -> ApiError:
    return ApiError(
        "WORKSPACE_FORBIDDEN",
        403,
        f"This action needs the {need} role in this workspace; you have {actual}.",
    )


def _as_uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def membership(
    db: Session, user_id: uuid.UUID, workspace_id: uuid.UUID
) -> WorkspaceMember | None:
    return db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.user_id == user_id,
        )
    )


def require_workspace(
    db: Session, user_id: uuid.UUID, workspace_id: str, *, need: str
) -> Workspace:
    key = _as_uuid(workspace_id)
    if key is None:
        raise _not_found()
    workspace = db.get(Workspace, key)
    if workspace is None:
        raise _not_found()
    member = membership(db, user_id, workspace.id)
    if member is None:
        raise _not_found()
    if not at_least(member.role, need):
        raise _forbidden(need, member.role)
    return workspace


def require_access(
    db: Session, user_id: uuid.UUID, report_id: str, *, need: str
) -> Report:
    """Resolve report -> workspace -> membership, or raise.

    Replaces `get_owned_report`. `Report.owner_user_id` is deliberately not
    consulted: it records who created the report, not who may read it.
    """
    key = _as_uuid(report_id)
    if key is None:
        raise _not_found()
    report = db.get(Report, key)
    if report is None:
        raise _not_found()
    member = membership(db, user_id, report.workspace_id)
    if member is None:
        raise _not_found()
    if not at_least(member.role, need):
        raise _forbidden(need, member.role)
    return report
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_workspace_access.py -v`
Expected: PASS (13 tests)

- [ ] **Step 6: Write the failing personal-workspace test**

Append to `backend/tests/test_workspace_access.py`:

```python
from app.auth.sessions import create_session
from app.workspaces.service import ensure_personal_workspace


def test_signing_in_creates_a_personal_workspace(db):
    create_session(db, account="ACME", user="ALICE", mode="dev")
    db.commit()
    ws = db.query(Workspace).one()
    assert ws.kind == "personal"
    assert ws.name == "My reports"
    assert ws.snowflake_account == "ACME"
    assert db.query(WorkspaceMember).one().role == "admin"


def test_signing_in_twice_does_not_create_a_second_personal_workspace(db):
    create_session(db, account="ACME", user="ALICE", mode="dev")
    db.commit()
    create_session(db, account="ACME", user="ALICE", mode="dev")
    db.commit()
    assert db.query(Workspace).count() == 1


def test_two_users_get_separate_personal_workspaces(db):
    create_session(db, account="ACME", user="ALICE", mode="dev")
    create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    assert db.query(Workspace).count() == 2


def test_ensure_personal_workspace_is_idempotent(db):
    user = User(snowflake_account="ACME", snowflake_user="ALICE")
    db.add(user)
    db.flush()
    first = ensure_personal_workspace(db, user)
    second = ensure_personal_workspace(db, user)
    assert first.id == second.id
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_workspace_access.py -v -k personal`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.workspaces.service'`

- [ ] **Step 8: Write `ensure_personal_workspace` and call it on login**

```python
# backend/app/workspaces/service.py
"""Workspace and membership operations, including the guard rails.

The guard rails live here rather than in routes.py because they are rules
about the data, not about HTTP -- and because a rule enforced only in a route
is a rule the next route forgets.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import User, Workspace, WorkspaceMember
from app.errors import ApiError

PERSONAL_WORKSPACE_NAME = "My reports"


def ensure_personal_workspace(db: Session, user: User) -> Workspace:
    """Get or create this user's private workspace.

    Called on every login rather than from the migration, so that a user who
    has never signed in does not accumulate a workspace they may never use,
    and a user added as a member before their first login still resolves.
    """
    existing = db.scalar(
        select(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user.id, Workspace.kind == "personal")
    )
    if existing is not None:
        return existing

    workspace = Workspace(
        name=PERSONAL_WORKSPACE_NAME,
        kind="personal",
        snowflake_account=user.snowflake_account,
    )
    db.add(workspace)
    db.flush()
    db.add(
        WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="admin")
    )
    db.flush()
    return workspace
```

In `backend/app/auth/sessions.py`, inside `create_session`, immediately after the user is created or found and flushed:

```python
    # Every user has exactly one personal workspace, so that "which workspace
    # does this report belong to" always has an answer and there is no second,
    # unfiled access path.
    from app.workspaces.service import ensure_personal_workspace

    ensure_personal_workspace(db, existing)
```

The import is function-local to avoid a cycle: `app.workspaces.service` imports models, and `app.auth.sessions` is imported during app construction before the workspaces package is ready.

- [ ] **Step 9: Give the test suite a workspace helper**

Every existing test that builds a `Report` now needs a workspace. Add to `backend/tests/conftest.py`:

```python
@pytest.fixture
def personal_workspace(db):
    """A user with their personal workspace, for tests that need a report to
    live somewhere. Returns (user, workspace)."""
    from app.db.models import User
    from app.workspaces.service import ensure_personal_workspace

    user = User(snowflake_account="ACME", snowflake_user="ALICE")
    db.add(user)
    db.flush()
    workspace = ensure_personal_workspace(db, user)
    db.commit()
    return user, workspace
```

Add `import pytest` at the top if absent.

- [ ] **Step 10: Run the whole backend suite and fix the fallout**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`

Expected: failures in `test_report_routes.py`, `test_report_import.py` and `test_reports_it.py`, all from `Report` rows with no `workspace_id`. Fix each by routing through the session helper (`sign_in` already calls `create_session`, which now creates the workspace) and giving `service.create_report` the workspace — Task 3 changes that signature, so for now pass the personal workspace explicitly.

Do **not** make `workspace_id` nullable to make these pass. The column being NOT NULL is the guarantee that there is exactly one access path.

- [ ] **Step 11: Commit**

```bash
git add backend/app/workspaces backend/app/auth/sessions.py backend/tests/
git commit -m "feat: role ladder, access checks, and a personal workspace per user"
```

---

## Task 3: Every report route switches to `require_access`

This is the interface change the whole sub-project turns on. `get_owned_report` is deleted, not deprecated — leaving it behind is leaving a second access path that will eventually be called by mistake.

**Files:**
- Modify: `backend/app/reports/service.py`, `backend/app/reports/routes.py`
- Test: `backend/tests/test_report_routes.py`

**Interfaces:**
- Consumes: `access.require_access(db, user_id, report_id, *, need) -> Report`
- Produces:
  - `service.list_reports(db, user_id, workspace_id=None) -> list[Report]` — across every workspace the caller belongs to
  - `service.create_report(db, user_id, workspace_id, raw_definition) -> Report`
  - `service.update_report(db, user_id, report_id, raw_definition) -> Report`
  - `service.delete_report(db, user_id, report_id) -> None`
  - `service.import_report(db, user_id, workspace_id, entry, cache, raw_definition, view_override=None) -> Report`
  - `POST /api/reports` and `/api/reports/import` accept `workspaceId` (optional; defaults to the caller's personal workspace)

- [ ] **Step 1: Write the failing route tests**

Append to `backend/tests/test_report_routes.py`. The file's `sign_in` helper already calls `create_session`, which now also creates the personal workspace.

```python
from app.db.models import Workspace, WorkspaceMember


def _other_user_workspace(db, *, account="ACME", user="BOB"):
    """A second user with their own personal workspace and one report."""
    from app.auth.sessions import create_session

    sess = create_session(db, account=account, user=user, mode="dev")
    db.commit()
    ws = (
        db.query(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .filter(WorkspaceMember.user_id == sess.user_id)
        .one()
    )
    return sess, ws


def test_a_report_in_someone_elses_workspace_is_404(client, db):
    sign_in(client, db)
    _, other_ws = _other_user_workspace(db)
    from app.db.models import Report

    theirs = Report(
        owner_user_id=other_ws.id, workspace_id=other_ws.id, name="Theirs",
        view_database="D", view_schema="S", view_name="V", definition={},
    )
    db.add(theirs)
    db.commit()

    assert client.get(f"/api/reports/{theirs.id}").status_code == 404
    assert client.put(
        f"/api/reports/{theirs.id}", json={"definition": valid_definition()}
    ).status_code == 404
    assert client.delete(f"/api/reports/{theirs.id}").status_code == 404
    assert client.get(f"/api/reports/{theirs.id}/export").status_code == 404


def test_a_viewer_may_read_but_not_write(client, db):
    """The role split, end to end: same report, same workspace, two verbs."""
    sess = sign_in(client, db)
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=sess.user_id, role="viewer"))
    from app.db.models import Report

    report = Report(
        owner_user_id=sess.user_id, workspace_id=ws.id, name="Shared",
        view_database="D", view_schema="S", view_name="V",
        definition=valid_definition(),
    )
    db.add(report)
    db.commit()

    assert client.get(f"/api/reports/{report.id}").status_code == 200
    assert client.get(f"/api/reports/{report.id}/export").status_code == 200

    write = client.put(
        f"/api/reports/{report.id}", json={"definition": valid_definition()}
    )
    assert write.status_code == 403
    assert write.json()["code"] == "WORKSPACE_FORBIDDEN"
    assert client.delete(f"/api/reports/{report.id}").status_code == 403


def test_an_editor_may_write(client, db):
    sess = sign_in(client, db)
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=sess.user_id, role="editor"))
    from app.db.models import Report

    report = Report(
        owner_user_id=sess.user_id, workspace_id=ws.id, name="Shared",
        view_database="D", view_schema="S", view_name="V",
        definition=valid_definition(),
    )
    db.add(report)
    db.commit()
    assert client.put(
        f"/api/reports/{report.id}", json={"definition": valid_definition()}
    ).status_code == 200


def test_listing_spans_every_workspace_i_belong_to(client, db):
    sess = sign_in(client, db)
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=sess.user_id, role="viewer"))
    from app.db.models import Report

    db.add(
        Report(
            owner_user_id=sess.user_id, workspace_id=ws.id, name="In the team ws",
            view_database="D", view_schema="S", view_name="V", definition={},
        )
    )
    db.commit()
    client.post("/api/reports", json={"definition": valid_definition()})

    names = [r["name"] for r in client.get("/api/reports").json()["reports"]]
    assert "In the team ws" in names
    assert "Sales overview" in names


def test_listing_can_be_scoped_to_one_workspace(client, db):
    sess = sign_in(client, db)
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=sess.user_id, role="viewer"))
    from app.db.models import Report

    db.add(
        Report(
            owner_user_id=sess.user_id, workspace_id=ws.id, name="In the team ws",
            view_database="D", view_schema="S", view_name="V", definition={},
        )
    )
    db.commit()
    client.post("/api/reports", json={"definition": valid_definition()})

    scoped = client.get("/api/reports", params={"workspace": str(ws.id)}).json()
    assert [r["name"] for r in scoped["reports"]] == ["In the team ws"]


def test_a_new_report_lands_in_my_personal_workspace_by_default(client, db):
    sess = sign_in(client, db)
    created = client.post("/api/reports", json={"definition": valid_definition()}).json()
    personal = (
        db.query(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .filter(WorkspaceMember.user_id == sess.user_id, Workspace.kind == "personal")
        .one()
    )
    assert created["workspaceId"] == str(personal.id)


def test_creating_in_a_workspace_i_cannot_write_to_is_403(client, db):
    sess = sign_in(client, db)
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=sess.user_id, role="viewer"))
    db.commit()
    response = client.post(
        "/api/reports",
        json={"definition": valid_definition(), "workspaceId": str(ws.id)},
    )
    assert response.status_code == 403


def test_creating_in_a_workspace_i_do_not_belong_to_is_404(client, db):
    sign_in(client, db)
    _, other_ws = _other_user_workspace(db)
    response = client.post(
        "/api/reports",
        json={"definition": valid_definition(), "workspaceId": str(other_ws.id)},
    )
    assert response.status_code == 404


def test_a_report_summary_names_its_workspace(client, db):
    sign_in(client, db)
    created = client.post("/api/reports", json={"definition": valid_definition()}).json()
    assert created["workspaceId"]
    assert created["workspaceName"] == "My reports"
    assert created["myRole"] == "admin"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_report_routes.py -v`
Expected: FAIL — `workspaceId` missing from responses, cross-workspace reads still succeeding through `get_owned_report`.

- [ ] **Step 3: Rewrite the service layer**

In `backend/app/reports/service.py`, delete `get_owned_report` and `_not_found` entirely, and replace the CRUD functions:

```python
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Report, Workspace, WorkspaceMember
from app.errors import ApiError
from app.reports.catalog import wells_to_query
from app.reports.schema import ReportDefinition, parse_definition
from app.workspaces.access import require_access, require_workspace


def list_reports(
    db: Session, user_id: uuid.UUID, workspace_id: str | None = None
) -> list[Report]:
    """Every report in every workspace this user belongs to.

    Joined through membership rather than filtered on `owner_user_id`: a
    shared report is not owned by the person reading it.
    """
    query = (
        select(Report)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Report.workspace_id)
        .where(WorkspaceMember.user_id == user_id)
        .order_by(Report.updated_at.desc())
    )
    if workspace_id:
        # Through require_workspace, so a bogus or unauthorised id is a 404
        # rather than a silently empty list.
        workspace = require_workspace(db, user_id, workspace_id, need="viewer")
        query = query.where(Report.workspace_id == workspace.id)
    return list(db.scalars(query))


def personal_workspace_id(db: Session, user_id: uuid.UUID) -> uuid.UUID:
    workspace = db.scalar(
        select(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user_id, Workspace.kind == "personal")
    )
    if workspace is None:
        # Every login creates one, so this means the session outlived a
        # database reset. Better an explicit error than a null workspace_id.
        raise ApiError(
            "HTTP_ERROR", 404, "You have no personal workspace; sign in again."
        )
    return workspace.id


def _resolve_target(
    db: Session, user_id: uuid.UUID, workspace_id: str | None
) -> uuid.UUID:
    if workspace_id:
        return require_workspace(db, user_id, workspace_id, need="editor").id
    return personal_workspace_id(db, user_id)


def create_report(
    db: Session, user_id: uuid.UUID, workspace_id: str | None, raw_definition: dict
) -> Report:
    target = _resolve_target(db, user_id, workspace_id)
    definition = parse_definition(raw_definition)
    report = Report(
        owner_user_id=user_id, workspace_id=target, name=definition.name,
        view_database="", view_schema="", view_name="", definition={},
    )
    _apply(report, definition)
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


def update_report(
    db: Session, user_id: uuid.UUID, report_id: str, raw_definition: dict
) -> Report:
    report = require_access(db, user_id, report_id, need="editor")
    _apply(report, parse_definition(raw_definition))
    db.commit()
    db.refresh(report)
    return report


def delete_report(db: Session, user_id: uuid.UUID, report_id: str) -> None:
    report = require_access(db, user_id, report_id, need="editor")
    db.delete(report)
    db.commit()
```

`_apply` is unchanged. In `import_report`, change the signature to take `workspace_id: str | None` after `user_id`, resolve it with `_resolve_target` as the first statement, and set `workspace_id=target` on the constructed `Report`.

- [ ] **Step 4: Rewrite the routes**

In `backend/app/reports/routes.py`:

```python
from app.workspaces.access import require_access
```

Extend the response shapers so the client knows where a report lives and what the caller may do with it:

```python
def _summary(report: Report, *, workspace: Workspace, role: str) -> dict:
    return {
        "id": str(report.id),
        "name": report.name,
        "view": {
            "database": report.view_database,
            "schema": report.view_schema,
            "name": report.view_name,
        },
        "updatedAt": report.updated_at.isoformat(),
        "workspaceId": str(report.workspace_id),
        "workspaceName": workspace.name,
        #: The caller's role here, so the UI can disable Save with a reason
        #: rather than letting them discover it on a 403.
        "myRole": role,
    }
```

Add a helper that fetches both in one place, since every route needs them:

```python
def _context(db: Session, user_id, report: Report) -> tuple[Workspace, str]:
    workspace = db.get(Workspace, report.workspace_id)
    member = membership(db, user_id, report.workspace_id)
    # Both are guaranteed present: require_access already resolved them.
    return workspace, member.role
```

Then each route:

```python
@router.get("/api/reports")
def list_reports(
    workspace: str | None = None,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    reports = service.list_reports(db, sess.user_id, workspace)
    return {
        "reports": [
            _summary(r, **dict(zip(("workspace", "role"), _context(db, sess.user_id, r))))
            for r in reports
        ]
    }
```

That `zip` is too clever for its own good — write it plainly instead:

```python
    out = []
    for report in reports:
        workspace_row, role = _context(db, sess.user_id, report)
        out.append(_summary(report, workspace=workspace_row, role=role))
    return {"reports": out}
```

`DefinitionBody` gains `workspaceId: str | None = None`, and `ImportBody` likewise. `create_report` and `import_report` pass it through. `get_report`, `update_report`, `delete_report` and `export_report` each call `service.*`, which now performs the access check internally — except `export_report` and `get_report`, which call `require_access(db, sess.user_id, report_id, need="viewer")` directly.

- [ ] **Step 5: Run the backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`
Expected: PASS. Any remaining failure is a test still calling `get_owned_report`; that function is gone on purpose — switch the call to `require_access` with an explicit `need`.

- [ ] **Step 6: Commit**

```bash
git add backend/app/reports backend/tests/test_report_routes.py
git commit -m "feat: report access resolves through workspace membership"
```

---

## Task 4: Workspace endpoints

**Files:**
- Create: `backend/app/workspaces/routes.py`
- Modify: `backend/app/workspaces/service.py`, `backend/app/main.py`
- Test: `backend/tests/test_workspace_routes.py`

**Interfaces:**
- Produces:
  - `GET /api/workspaces` → `{"workspaces": [{id, name, kind, myRole, memberCount, reportCount}]}`
  - `POST /api/workspaces` `{name}` → 201, creator becomes admin
  - `PATCH /api/workspaces/{id}` `{name}` → admin, not personal
  - `DELETE /api/workspaces/{id}` → 204, admin, not personal, cascades to reports
  - `service.create_workspace(db, user_id, account, name) -> Workspace`
  - `service.rename_workspace(db, user_id, workspace_id, name) -> Workspace`
  - `service.delete_workspace(db, user_id, workspace_id) -> None`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_workspace_routes.py
from app.auth.sessions import SESSION_COOKIE, create_session
from app.db.models import Report, Workspace, WorkspaceMember


def sign_in(client, db, *, account="ACME", user="ALICE"):
    sess = create_session(db, account=account, user=user, mode="dev")
    db.commit()
    client.cookies.set(SESSION_COOKIE, sess.id)
    return sess


def test_endpoints_require_auth(client):
    assert client.get("/api/workspaces").status_code == 401
    assert client.post("/api/workspaces", json={"name": "X"}).status_code == 401


def test_listing_shows_my_personal_workspace_first(client, db):
    sign_in(client, db)
    client.post("/api/workspaces", json={"name": "Team"})
    body = client.get("/api/workspaces").json()["workspaces"]
    assert body[0]["kind"] == "personal"
    assert body[0]["name"] == "My reports"
    assert [w["name"] for w in body][1:] == ["Team"]


def test_creating_a_workspace_makes_me_its_admin(client, db):
    sign_in(client, db)
    created = client.post("/api/workspaces", json={"name": "Team"})
    assert created.status_code == 201
    assert created.json()["myRole"] == "admin"
    assert created.json()["kind"] == "shared"


def test_a_new_workspace_inherits_my_snowflake_account(client, db):
    sign_in(client, db, account="XRIIEIM")
    created = client.post("/api/workspaces", json={"name": "Team"}).json()
    ws = db.get(Workspace, __import__("uuid").UUID(created["id"]))
    assert ws.snowflake_account == "XRIIEIM"


def test_listing_never_shows_a_workspace_i_do_not_belong_to(client, db):
    sign_in(client, db)
    other = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    stranger = Workspace(name="Secret", kind="shared", snowflake_account="ACME")
    db.add(stranger)
    db.flush()
    db.add(
        WorkspaceMember(workspace_id=stranger.id, user_id=other.user_id, role="admin")
    )
    db.commit()
    names = [w["name"] for w in client.get("/api/workspaces").json()["workspaces"]]
    assert "Secret" not in names


def test_listing_counts_members_and_reports(client, db):
    sess = sign_in(client, db)
    created = client.post("/api/workspaces", json={"name": "Team"}).json()
    client.post(
        "/api/reports",
        json={"definition": valid_definition(), "workspaceId": created["id"]},
    )
    row = next(
        w for w in client.get("/api/workspaces").json()["workspaces"]
        if w["id"] == created["id"]
    )
    assert row["memberCount"] == 1
    assert row["reportCount"] == 1


def test_renaming_requires_admin(client, db):
    sess = sign_in(client, db)
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=sess.user_id, role="editor"))
    db.commit()
    response = client.patch(f"/api/workspaces/{ws.id}", json={"name": "Renamed"})
    assert response.status_code == 403
    assert response.json()["code"] == "WORKSPACE_FORBIDDEN"


def test_a_personal_workspace_cannot_be_renamed_or_deleted(client, db):
    sign_in(client, db)
    personal = client.get("/api/workspaces").json()["workspaces"][0]
    rename = client.patch(f"/api/workspaces/{personal['id']}", json={"name": "Nope"})
    assert rename.status_code == 400
    assert "personal" in rename.json()["message"].lower()
    assert client.delete(f"/api/workspaces/{personal['id']}").status_code == 400


def test_deleting_a_workspace_deletes_its_reports(client, db):
    sign_in(client, db)
    created = client.post("/api/workspaces", json={"name": "Team"}).json()
    client.post(
        "/api/reports",
        json={"definition": valid_definition(), "workspaceId": created["id"]},
    )
    assert db.query(Report).count() == 1
    assert client.delete(f"/api/workspaces/{created['id']}").status_code == 204
    assert db.query(Report).count() == 0
    assert db.query(WorkspaceMember).filter_by(
        workspace_id=__import__("uuid").UUID(created["id"])
    ).count() == 0


def test_a_stranger_deleting_a_workspace_gets_404(client, db):
    sign_in(client, db)
    other = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    stranger = Workspace(name="Secret", kind="shared", snowflake_account="ACME")
    db.add(stranger)
    db.flush()
    db.add(
        WorkspaceMember(workspace_id=stranger.id, user_id=other.user_id, role="admin")
    )
    db.commit()
    assert client.delete(f"/api/workspaces/{stranger.id}").status_code == 404


def test_a_workspace_name_is_required(client, db):
    sign_in(client, db)
    assert client.post("/api/workspaces", json={"name": ""}).status_code == 422
```

Import `valid_definition` from `tests.test_report_routes` at the top of the file.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_workspace_routes.py -v`
Expected: FAIL — 404 on every route; the router does not exist.

- [ ] **Step 3: Add the service functions**

Append to `backend/app/workspaces/service.py`:

```python
def _reject_personal(workspace: Workspace, action: str) -> None:
    """A personal workspace is a person, not a group.

    Renaming or deleting it, or adding someone to it, would quietly turn "my
    private drafts" into something else. Enforced here rather than by hiding a
    button, because a hidden button is not a rule.
    """
    if workspace.kind == "personal":
        raise ApiError(
            "REPORT_INVALID",
            400,
            f"A personal workspace cannot be {action}. Create a shared "
            "workspace to collaborate.",
        )


def create_workspace(
    db: Session, user_id: uuid.UUID, account: str, name: str
) -> Workspace:
    workspace = Workspace(name=name, kind="shared", snowflake_account=account)
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user_id, role="admin"))
    db.commit()
    db.refresh(workspace)
    return workspace


def rename_workspace(
    db: Session, user_id: uuid.UUID, workspace_id: str, name: str
) -> Workspace:
    workspace = require_workspace(db, user_id, workspace_id, need="admin")
    _reject_personal(workspace, "renamed")
    workspace.name = name
    db.commit()
    db.refresh(workspace)
    return workspace


def delete_workspace(db: Session, user_id: uuid.UUID, workspace_id: str) -> None:
    workspace = require_workspace(db, user_id, workspace_id, need="admin")
    _reject_personal(workspace, "deleted")
    # Explicit deletes rather than relying on ondelete="CASCADE": SQLite does
    # not enforce foreign keys by default, so the cascade that works on
    # Postgres would silently leave orphans in dev and in the test suite.
    db.query(Report).filter(Report.workspace_id == workspace.id).delete()
    db.query(WorkspaceMember).filter(
        WorkspaceMember.workspace_id == workspace.id
    ).delete()
    db.delete(workspace)
    db.commit()
```

Add `Report` and `require_workspace` to the imports at the top of the module.

- [ ] **Step 4: Write the router**

```python
# backend/app/workspaces/routes.py
from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.db.base import get_db
from app.db.models import DbSession, Report, Workspace, WorkspaceMember
from app.workspaces import service
from app.workspaces.access import require_workspace

router = APIRouter()


class WorkspaceBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)


def _row(workspace: Workspace, role: str, members: int, reports: int) -> dict:
    return {
        "id": str(workspace.id),
        "name": workspace.name,
        "kind": workspace.kind,
        "myRole": role,
        "memberCount": members,
        "reportCount": reports,
    }


@router.get("/api/workspaces")
def list_workspaces(
    sess: DbSession = Depends(current_session), db: Session = Depends(get_db)
) -> dict:
    rows = db.execute(
        select(Workspace, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == sess.user_id)
        # Personal first, then alphabetical: "my drafts" is where people look
        # first, and a switcher that reorders itself is disorienting.
        .order_by(Workspace.kind.desc(), Workspace.name)
    ).all()

    out = []
    for workspace, role in rows:
        members = db.scalar(
            select(func.count())
            .select_from(WorkspaceMember)
            .where(WorkspaceMember.workspace_id == workspace.id)
        )
        reports = db.scalar(
            select(func.count())
            .select_from(Report)
            .where(Report.workspace_id == workspace.id)
        )
        out.append(_row(workspace, role, members or 0, reports or 0))
    return {"workspaces": out}
```

`Workspace.kind.desc()` sorts "personal" before "shared" only because "p" < "s" reversed — that is too subtle to rely on. Order explicitly instead:

```python
        .order_by((Workspace.kind != "personal"), Workspace.name)
```

A false sorts before a true, so personal workspaces come first regardless of how the strings compare.

```python
@router.post("/api/workspaces", status_code=201)
def create_workspace(
    body: WorkspaceBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    workspace = service.create_workspace(
        db, sess.user_id, sess.user.snowflake_account, body.name
    )
    return _row(workspace, "admin", 1, 0)


@router.patch("/api/workspaces/{workspace_id}")
def rename_workspace(
    workspace_id: str,
    body: WorkspaceBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    workspace = service.rename_workspace(db, sess.user_id, workspace_id, body.name)
    return _row(workspace, "admin", 0, 0)


@router.delete("/api/workspaces/{workspace_id}", status_code=204)
def delete_workspace(
    workspace_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    service.delete_workspace(db, sess.user_id, workspace_id)
    return Response(status_code=204)
```

`_row` on rename returns zero counts, which the client would render as "0 members". Return the real counts instead — reuse the same two `select(func.count())` queries by extracting them into a module-level `_counts(db, workspace) -> tuple[int, int]` and calling it from all three places.

Register the router in `backend/app/main.py` alongside the existing ones.

- [ ] **Step 5: Run the tests**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_workspace_routes.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/app/workspaces backend/app/main.py backend/tests/test_workspace_routes.py
git commit -m "feat: workspace endpoints"
```

---

## Task 5: Membership, and the guard rails

**Files:**
- Modify: `backend/app/workspaces/service.py`, `backend/app/workspaces/routes.py`
- Test: `backend/tests/test_workspace_members.py`

**Interfaces:**
- Produces:
  - `GET /api/workspaces/{id}/members` → `{"members": [{userId, snowflakeUser, role, isMe}]}`
  - `POST /api/workspaces/{id}/members` `{snowflakeUser, role}` → 201
  - `PATCH /api/workspaces/{id}/members/{user_id}` `{role}`
  - `DELETE /api/workspaces/{id}/members/{user_id}` → 204
  - `service.add_member(db, user_id, workspace_id, snowflake_user, role) -> WorkspaceMember`
  - `service.set_member_role(db, user_id, workspace_id, member_user_id, role) -> WorkspaceMember`
  - `service.remove_member(db, user_id, workspace_id, member_user_id) -> None`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_workspace_members.py
import uuid

from app.db.models import User, Workspace, WorkspaceMember
from tests.test_workspace_routes import sign_in


def a_shared_workspace(client, name="Team"):
    return client.post("/api/workspaces", json={"name": name}).json()


def test_a_new_workspace_has_exactly_one_member_me(client, db):
    sign_in(client, db)
    ws = a_shared_workspace(client)
    members = client.get(f"/api/workspaces/{ws['id']}/members").json()["members"]
    assert len(members) == 1
    assert members[0]["snowflakeUser"] == "ALICE"
    assert members[0]["role"] == "admin"
    assert members[0]["isMe"] is True


def test_adding_a_member_by_snowflake_username(client, db):
    sign_in(client, db)
    ws = a_shared_workspace(client)
    added = client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "BOB", "role": "editor"},
    )
    assert added.status_code == 201
    assert added.json()["snowflakeUser"] == "BOB"
    assert added.json()["role"] == "editor"


def test_adding_a_member_who_has_never_signed_in_creates_their_user_row(client, db):
    """You cannot require a colleague to log in before you are allowed to
    share with them."""
    sign_in(client, db)
    ws = a_shared_workspace(client)
    assert db.query(User).filter_by(snowflake_user="CAROL").count() == 0
    client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "CAROL", "role": "viewer"},
    )
    assert db.query(User).filter_by(snowflake_user="CAROL").count() == 1


def test_adding_the_same_member_twice_is_rejected(client, db):
    sign_in(client, db)
    ws = a_shared_workspace(client)
    client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "BOB", "role": "viewer"},
    )
    again = client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "BOB", "role": "admin"},
    )
    assert again.status_code == 400
    assert "already" in again.json()["message"].lower()


def test_only_an_admin_may_add_members(client, db):
    sess = sign_in(client, db)
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=sess.user_id, role="editor"))
    db.commit()
    response = client.post(
        f"/api/workspaces/{ws.id}/members",
        json={"snowflakeUser": "BOB", "role": "viewer"},
    )
    assert response.status_code == 403


def test_a_member_may_list_members(client, db):
    """Seeing who else is here is not an admin power -- you need it to know
    who your work is visible to."""
    sess = sign_in(client, db)
    ws = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=sess.user_id, role="viewer"))
    db.commit()
    assert client.get(f"/api/workspaces/{ws.id}/members").status_code == 200


def test_a_personal_workspace_refuses_members(client, db):
    sign_in(client, db)
    personal = client.get("/api/workspaces").json()["workspaces"][0]
    response = client.post(
        f"/api/workspaces/{personal['id']}/members",
        json={"snowflakeUser": "BOB", "role": "viewer"},
    )
    assert response.status_code == 400
    assert "personal" in response.json()["message"].lower()


def test_a_user_from_another_snowflake_account_is_rejected(client, db):
    """Their credentials could never resolve this workspace's views, so the
    grant would be an illusion of access."""
    sign_in(client, db, account="ACME")
    ws = a_shared_workspace(client)
    db.add(User(snowflake_account="OTHERCORP", snowflake_user="MALLORY"))
    db.commit()
    response = client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "MALLORY", "role": "viewer", "snowflakeAccount": "OTHERCORP"},
    )
    assert response.status_code == 400
    assert "account" in response.json()["message"].lower()


def test_an_unknown_role_is_rejected(client, db):
    sign_in(client, db)
    ws = a_shared_workspace(client)
    response = client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "BOB", "role": "superuser"},
    )
    assert response.status_code == 422


def test_changing_a_members_role(client, db):
    sign_in(client, db)
    ws = a_shared_workspace(client)
    added = client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "BOB", "role": "viewer"},
    ).json()
    changed = client.patch(
        f"/api/workspaces/{ws['id']}/members/{added['userId']}",
        json={"role": "admin"},
    )
    assert changed.status_code == 200
    assert changed.json()["role"] == "admin"


def test_removing_a_member(client, db):
    sign_in(client, db)
    ws = a_shared_workspace(client)
    added = client.post(
        f"/api/workspaces/{ws['id']}/members",
        json={"snowflakeUser": "BOB", "role": "viewer"},
    ).json()
    assert client.delete(
        f"/api/workspaces/{ws['id']}/members/{added['userId']}"
    ).status_code == 204
    members = client.get(f"/api/workspaces/{ws['id']}/members").json()["members"]
    assert [m["snowflakeUser"] for m in members] == ["ALICE"]


class TestLastAdmin:
    """A workspace with no admin can never have its membership changed again.
    Every route into that state is closed."""

    def test_the_last_admin_cannot_be_removed(self, client, db):
        sign_in(client, db)
        ws = a_shared_workspace(client)
        me = client.get(f"/api/workspaces/{ws['id']}/members").json()["members"][0]
        response = client.delete(
            f"/api/workspaces/{ws['id']}/members/{me['userId']}"
        )
        assert response.status_code == 400
        assert "last admin" in response.json()["message"].lower()

    def test_the_last_admin_cannot_be_demoted(self, client, db):
        sign_in(client, db)
        ws = a_shared_workspace(client)
        me = client.get(f"/api/workspaces/{ws['id']}/members").json()["members"][0]
        response = client.patch(
            f"/api/workspaces/{ws['id']}/members/{me['userId']}",
            json={"role": "editor"},
        )
        assert response.status_code == 400
        assert "last admin" in response.json()["message"].lower()

    def test_an_admin_may_leave_once_another_admin_exists(self, client, db):
        sign_in(client, db)
        ws = a_shared_workspace(client)
        me = client.get(f"/api/workspaces/{ws['id']}/members").json()["members"][0]
        client.post(
            f"/api/workspaces/{ws['id']}/members",
            json={"snowflakeUser": "BOB", "role": "admin"},
        )
        assert client.delete(
            f"/api/workspaces/{ws['id']}/members/{me['userId']}"
        ).status_code == 204

    def test_demoting_one_of_two_admins_is_allowed(self, client, db):
        sign_in(client, db)
        ws = a_shared_workspace(client)
        added = client.post(
            f"/api/workspaces/{ws['id']}/members",
            json={"snowflakeUser": "BOB", "role": "admin"},
        ).json()
        assert client.patch(
            f"/api/workspaces/{ws['id']}/members/{added['userId']}",
            json={"role": "viewer"},
        ).status_code == 200


def test_removing_a_member_who_is_not_one_is_404(client, db):
    sign_in(client, db)
    ws = a_shared_workspace(client)
    assert client.delete(
        f"/api/workspaces/{ws['id']}/members/{uuid.uuid4()}"
    ).status_code == 404
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_workspace_members.py -v`
Expected: FAIL — 404 on every member route.

- [ ] **Step 3: Write the service functions**

Append to `backend/app/workspaces/service.py`:

```python
def _admin_count(db: Session, workspace_id: uuid.UUID) -> int:
    return db.scalar(
        select(func.count())
        .select_from(WorkspaceMember)
        .where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.role == "admin",
        )
    ) or 0


def _guard_last_admin(db: Session, member: WorkspaceMember, action: str) -> None:
    """A workspace whose last admin is removed or demoted can never have its
    membership changed again -- there is no one left who may change it. The
    check covers demotion as well as removal, and applies to a user acting on
    themselves.
    """
    if member.role != "admin":
        return
    if _admin_count(db, member.workspace_id) > 1:
        return
    raise ApiError(
        "REPORT_INVALID",
        400,
        f"This is the last admin of the workspace, so they cannot be {action}. "
        "Promote another member to admin first.",
    )


def _member_or_404(
    db: Session, workspace_id: uuid.UUID, member_user_id: str
) -> WorkspaceMember:
    key = _as_uuid(member_user_id)
    member = (
        db.scalar(
            select(WorkspaceMember).where(
                WorkspaceMember.workspace_id == workspace_id,
                WorkspaceMember.user_id == key,
            )
        )
        if key
        else None
    )
    if member is None:
        raise ApiError("HTTP_ERROR", 404, "Not a member of this workspace")
    return member


def add_member(
    db: Session,
    user_id: uuid.UUID,
    workspace_id: str,
    snowflake_user: str,
    role: str,
    snowflake_account: str | None = None,
) -> WorkspaceMember:
    workspace = require_workspace(db, user_id, workspace_id, need="admin")
    _reject_personal(workspace, "given members")

    account = snowflake_account or workspace.snowflake_account
    if account.upper() != workspace.snowflake_account.upper():
        raise ApiError(
            "REPORT_INVALID",
            400,
            f"{snowflake_user} is in Snowflake account {account}, but this "
            f"workspace belongs to {workspace.snowflake_account}. Their "
            "credentials could not read its reports.",
        )

    target = db.scalar(
        select(User).where(
            User.snowflake_account == workspace.snowflake_account,
            User.snowflake_user == snowflake_user,
        )
    )
    if target is None:
        # Created on demand: requiring a colleague to log in before you may
        # share with them makes sharing useless for onboarding.
        target = User(
            snowflake_account=workspace.snowflake_account,
            snowflake_user=snowflake_user,
        )
        db.add(target)
        db.flush()

    if membership(db, target.id, workspace.id) is not None:
        raise ApiError(
            "REPORT_INVALID", 400, f"{snowflake_user} is already a member."
        )

    member = WorkspaceMember(
        workspace_id=workspace.id, user_id=target.id, role=role
    )
    db.add(member)
    db.commit()
    db.refresh(member)
    return member


def set_member_role(
    db: Session, user_id: uuid.UUID, workspace_id: str, member_user_id: str, role: str
) -> WorkspaceMember:
    workspace = require_workspace(db, user_id, workspace_id, need="admin")
    member = _member_or_404(db, workspace.id, member_user_id)
    if role != "admin":
        _guard_last_admin(db, member, "demoted")
    member.role = role
    db.commit()
    db.refresh(member)
    return member


def remove_member(
    db: Session, user_id: uuid.UUID, workspace_id: str, member_user_id: str
) -> None:
    workspace = require_workspace(db, user_id, workspace_id, need="admin")
    member = _member_or_404(db, workspace.id, member_user_id)
    _guard_last_admin(db, member, "removed")
    db.delete(member)
    db.commit()
```

Add to the imports: `from sqlalchemy import func, select`, `from app.db.models import User`, and `from app.workspaces.access import membership, require_workspace`. Add the `_as_uuid` helper by importing it from `app.workspaces.access` (export it there rather than duplicating).

- [ ] **Step 4: Write the member routes**

Append to `backend/app/workspaces/routes.py`:

```python
from typing import Literal

from app.workspaces.roles import ROLES


class AddMemberBody(BaseModel):
    snowflakeUser: str = Field(min_length=1, max_length=255)
    #: A closed enum, so an unknown role is a 422 at the edge rather than a
    #: string that silently satisfies nothing later.
    role: Literal["viewer", "editor", "admin"]
    snowflakeAccount: str | None = None


class RoleBody(BaseModel):
    role: Literal["viewer", "editor", "admin"]


def _member_row(db: Session, member: WorkspaceMember, me: uuid.UUID) -> dict:
    user = db.get(User, member.user_id)
    return {
        "userId": str(member.user_id),
        "snowflakeUser": user.snowflake_user if user else "",
        "role": member.role,
        "isMe": member.user_id == me,
    }


@router.get("/api/workspaces/{workspace_id}/members")
def list_members(
    workspace_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    # viewer, not admin: knowing who your work is visible to is not a
    # privileged question.
    workspace = require_workspace(db, sess.user_id, workspace_id, need="viewer")
    members = db.scalars(
        select(WorkspaceMember).where(WorkspaceMember.workspace_id == workspace.id)
    )
    return {"members": [_member_row(db, m, sess.user_id) for m in members]}


@router.post("/api/workspaces/{workspace_id}/members", status_code=201)
def add_member(
    workspace_id: str,
    body: AddMemberBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    member = service.add_member(
        db, sess.user_id, workspace_id, body.snowflakeUser, body.role,
        body.snowflakeAccount,
    )
    return _member_row(db, member, sess.user_id)


@router.patch("/api/workspaces/{workspace_id}/members/{member_user_id}")
def set_member_role(
    workspace_id: str,
    member_user_id: str,
    body: RoleBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    member = service.set_member_role(
        db, sess.user_id, workspace_id, member_user_id, body.role
    )
    return _member_row(db, member, sess.user_id)


@router.delete(
    "/api/workspaces/{workspace_id}/members/{member_user_id}", status_code=204
)
def remove_member(
    workspace_id: str,
    member_user_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> Response:
    service.remove_member(db, sess.user_id, workspace_id, member_user_id)
    return Response(status_code=204)
```

Add `import uuid` and `User` to the module's imports. `ROLES` is imported to keep the enum and the ladder visibly connected; if it ends up unused, delete the import rather than leaving it.

- [ ] **Step 5: Run the tests**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_workspace_members.py -v`
Expected: PASS

- [ ] **Step 6: Run the whole backend suite**

Run: `cd backend && .venv/Scripts/python.exe -m pytest -q`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/app/workspaces backend/tests/test_workspace_members.py
git commit -m "feat: workspace membership, with the last-admin and account guard rails"
```

---

## Task 6: Moving a report between workspaces

**Files:**
- Modify: `backend/app/reports/service.py`, `backend/app/reports/routes.py`
- Test: `backend/tests/test_report_move.py`

**Interfaces:**
- Produces: `service.move_report(db, user_id, report_id, workspace_id) -> Report`; `POST /api/reports/{id}/move` `{workspaceId}`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_report_move.py
from app.db.models import Report, Workspace, WorkspaceMember
from tests.test_report_routes import sign_in, valid_definition


def _workspace(db, user_id, name, role="editor"):
    ws = Workspace(name=name, kind="shared", snowflake_account="ACME")
    db.add(ws)
    db.flush()
    db.add(WorkspaceMember(workspace_id=ws.id, user_id=user_id, role=role))
    db.commit()
    return ws


def test_moving_a_report_i_can_edit_into_a_workspace_i_can_edit(client, db):
    sess = sign_in(client, db)
    source = _workspace(db, sess.user_id, "Source")
    destination = _workspace(db, sess.user_id, "Destination")
    report = Report(
        owner_user_id=sess.user_id, workspace_id=source.id, name="R",
        view_database="D", view_schema="S", view_name="V",
        definition=valid_definition(),
    )
    db.add(report)
    db.commit()

    response = client.post(
        f"/api/reports/{report.id}/move", json={"workspaceId": str(destination.id)}
    )
    assert response.status_code == 200
    assert response.json()["workspaceId"] == str(destination.id)
    db.refresh(report)
    assert report.workspace_id == destination.id


def test_moving_out_of_a_workspace_i_can_only_read_is_403(client, db):
    """Requiring editor only on the destination would let anyone lift a report
    out of a workspace they were merely shown."""
    sess = sign_in(client, db)
    source = _workspace(db, sess.user_id, "Source", role="viewer")
    destination = _workspace(db, sess.user_id, "Destination", role="editor")
    report = Report(
        owner_user_id=sess.user_id, workspace_id=source.id, name="R",
        view_database="D", view_schema="S", view_name="V",
        definition=valid_definition(),
    )
    db.add(report)
    db.commit()
    response = client.post(
        f"/api/reports/{report.id}/move", json={"workspaceId": str(destination.id)}
    )
    assert response.status_code == 403


def test_moving_into_a_workspace_i_can_only_read_is_403(client, db):
    """And requiring it only on the source would let anyone push a report into
    a workspace they cannot write to."""
    sess = sign_in(client, db)
    source = _workspace(db, sess.user_id, "Source", role="editor")
    destination = _workspace(db, sess.user_id, "Destination", role="viewer")
    report = Report(
        owner_user_id=sess.user_id, workspace_id=source.id, name="R",
        view_database="D", view_schema="S", view_name="V",
        definition=valid_definition(),
    )
    db.add(report)
    db.commit()
    response = client.post(
        f"/api/reports/{report.id}/move", json={"workspaceId": str(destination.id)}
    )
    assert response.status_code == 403


def test_moving_into_a_workspace_i_do_not_belong_to_is_404(client, db):
    from app.auth.sessions import create_session

    sess = sign_in(client, db)
    source = _workspace(db, sess.user_id, "Source")
    other = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    stranger = _workspace(db, other.user_id, "Theirs", role="admin")
    report = Report(
        owner_user_id=sess.user_id, workspace_id=source.id, name="R",
        view_database="D", view_schema="S", view_name="V",
        definition=valid_definition(),
    )
    db.add(report)
    db.commit()
    response = client.post(
        f"/api/reports/{report.id}/move", json={"workspaceId": str(stranger.id)}
    )
    assert response.status_code == 404


def test_moving_a_report_i_cannot_see_is_404(client, db):
    from app.auth.sessions import create_session

    sess = sign_in(client, db)
    destination = _workspace(db, sess.user_id, "Destination")
    other = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()
    theirs_ws = _workspace(db, other.user_id, "Theirs", role="admin")
    theirs = Report(
        owner_user_id=other.user_id, workspace_id=theirs_ws.id, name="Theirs",
        view_database="D", view_schema="S", view_name="V", definition={},
    )
    db.add(theirs)
    db.commit()
    response = client.post(
        f"/api/reports/{theirs.id}/move", json={"workspaceId": str(destination.id)}
    )
    assert response.status_code == 404


def test_moving_to_the_same_workspace_is_a_no_op_not_an_error(client, db):
    sess = sign_in(client, db)
    source = _workspace(db, sess.user_id, "Source")
    report = Report(
        owner_user_id=sess.user_id, workspace_id=source.id, name="R",
        view_database="D", view_schema="S", view_name="V",
        definition=valid_definition(),
    )
    db.add(report)
    db.commit()
    response = client.post(
        f"/api/reports/{report.id}/move", json={"workspaceId": str(source.id)}
    )
    assert response.status_code == 200
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_report_move.py -v`
Expected: FAIL — 404 on every call; the route does not exist.

- [ ] **Step 3: Implement**

Append to `backend/app/reports/service.py`:

```python
def move_report(
    db: Session, user_id: uuid.UUID, report_id: str, workspace_id: str
) -> Report:
    """Move a report to another workspace.

    Editor on BOTH ends. Requiring it only on the destination would let anyone
    lift a report out of a workspace they were merely shown; requiring it only
    on the source would let them push one into a workspace they cannot write
    to. Either half alone is a hole.
    """
    report = require_access(db, user_id, report_id, need="editor")
    destination = require_workspace(db, user_id, workspace_id, need="editor")
    report.workspace_id = destination.id
    db.commit()
    db.refresh(report)
    return report
```

Append to `backend/app/reports/routes.py`:

```python
class MoveBody(BaseModel):
    workspaceId: str


@router.post("/api/reports/{report_id}/move")
def move_report(
    report_id: str,
    body: MoveBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    report = service.move_report(db, sess.user_id, report_id, body.workspaceId)
    workspace, role = _context(db, sess.user_id, report)
    return _detail(report, workspace=workspace, role=role)
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_report_move.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/app/reports backend/tests/test_report_move.py
git commit -m "feat: move a report between workspaces, editor required on both ends"
```

---

## Task 7: The property this sub-project exists to preserve

Sharing shares report *definitions*. It never shares data. Everything else in this plan is plumbing; this task is the reason the plumbing has to be right.

**Files:**
- Test: `backend/tests/test_sharing_uses_viewer_credentials.py`

**Interfaces:**
- Consumes: everything from Tasks 1–6. Adds no production code — if a test here fails, the fix belongs in the module that broke the property, not here.

- [ ] **Step 1: Write the test**

```python
# backend/tests/test_sharing_uses_viewer_credentials.py
"""Sharing shares report DEFINITIONS. It never shares data.

Every query runs on `entry.conn` -- the connection belonging to the requesting
session, from that user's own Snowflake login. There is no service account, no
stored result set, and the describe cache lives inside each session's
CacheEntry rather than in a process global.

So two members of one workspace open the same report and get the same
definition, and each gets exactly the data their own Snowflake role permits.
A viewer whose role cannot read the view sees the report's shape and none of
its numbers. That is correct, not a bug to work around.

2a shipped a bug where the CLIENT query cache served one user's results to
another. These tests exist so the server-side equivalent cannot ship quietly.
"""

import pytest
from snowflake.connector.errors import ProgrammingError

from app.auth.sessions import SESSION_COOKIE, create_session
from app.db.models import Report, Workspace, WorkspaceMember
from app.snowflake.provider import get_cache
from tests.test_semantic_routes import ScriptedConnection
from tests.test_report_routes import valid_definition


class ForbiddenConnection(ScriptedConnection):
    """A connection whose role may DESCRIBE but may not SELECT.

    Shaped after what Snowflake actually does: the view is visible, the data
    is not.
    """

    def cursor(self):
        cursor = super().cursor()
        original = cursor.execute

        def execute(sql, params=None):
            if "SEMANTIC_VIEW" in sql and not sql.startswith("DESCRIBE"):
                raise ProgrammingError(
                    msg="Insufficient privileges to operate on semantic view",
                    errno=3001,
                )
            return original(sql, params)

        cursor.execute = execute
        return cursor


@pytest.fixture
def shared_report(client, db):
    """Alice and Bob both admin one workspace holding one report.

    Alice's connection answers normally; Bob's refuses to SELECT.
    """
    alice = create_session(db, account="ACME", user="ALICE", mode="dev")
    bob = create_session(db, account="ACME", user="BOB", mode="dev")
    db.commit()

    workspace = Workspace(name="Team", kind="shared", snowflake_account="ACME")
    db.add(workspace)
    db.flush()
    db.add_all([
        WorkspaceMember(workspace_id=workspace.id, user_id=alice.user_id, role="admin"),
        WorkspaceMember(workspace_id=workspace.id, user_id=bob.user_id, role="viewer"),
    ])
    report = Report(
        owner_user_id=alice.user_id, workspace_id=workspace.id, name="Shared",
        view_database="ANALYTICS", view_schema="PUBLIC", view_name="SALES",
        definition=valid_definition(),
    )
    db.add(report)
    db.commit()

    alice_conn, bob_conn = ScriptedConnection(), ForbiddenConnection()
    get_cache().put(alice.id, alice_conn)
    get_cache().put(bob.id, bob_conn)
    return {
        "alice": alice, "bob": bob, "report": report,
        "alice_conn": alice_conn, "bob_conn": bob_conn,
    }


def as_user(client, sess):
    client.cookies.set(SESSION_COOKIE, sess.id)
    return client


def test_both_members_get_the_same_definition(client, db, shared_report):
    """The definition IS shared. That is the whole point of a workspace."""
    report_id = shared_report["report"].id
    alice = as_user(client, shared_report["alice"]).get(f"/api/reports/{report_id}")
    bob = as_user(client, shared_report["bob"]).get(f"/api/reports/{report_id}")
    assert alice.status_code == bob.status_code == 200
    assert alice.json()["definition"] == bob.json()["definition"]


def test_each_member_queries_on_their_own_connection(client, db, shared_report):
    """The load-bearing assertion: Alice's query runs on Alice's connection and
    Bob's on Bob's. If a shared connection were ever introduced, one of these
    counts would stay at zero."""
    body = {
        "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
        "dimensions": ["ORDERS.ORDER_DATE"], "metrics": ["ORDERS.TOTAL_REVENUE"],
    }
    as_user(client, shared_report["alice"]).post("/api/query/semantic", json=body)
    assert shared_report["alice_conn"].cursor_obj.executed
    assert not shared_report["bob_conn"].cursor_obj.executed


def test_a_viewer_whose_role_cannot_read_gets_no_data(client, db, shared_report):
    """Bob may open the report and may not see its numbers. The definition
    crossed the workspace boundary; the data did not."""
    report_id = shared_report["report"].id
    detail = as_user(client, shared_report["bob"]).get(f"/api/reports/{report_id}")
    assert detail.status_code == 200

    query = client.post(
        "/api/query/semantic",
        json={
            "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
            "dimensions": ["ORDERS.ORDER_DATE"], "metrics": ["ORDERS.TOTAL_REVENUE"],
        },
    )
    assert query.status_code == 403
    assert query.json()["code"] == "SNOWFLAKE_FORBIDDEN"
    assert "rows" not in query.json()


def test_alice_still_gets_her_data(client, db, shared_report):
    """The negative case above must not pass merely because nothing works."""
    query = as_user(client, shared_report["alice"]).post(
        "/api/query/semantic",
        json={
            "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES",
            "dimensions": ["ORDERS.ORDER_DATE"], "metrics": ["ORDERS.TOTAL_REVENUE"],
        },
    )
    assert query.status_code == 200
    assert query.json()["rows"]


def test_a_describe_is_never_served_across_users(client, db, shared_report):
    """The describe cache lives inside each session's CacheEntry. If it were
    ever hoisted to a process global, Bob would be served Alice's catalog --
    a view he may not be entitled to see the shape of."""
    url = "/api/semantic-views/ANALYTICS/PUBLIC/SALES"
    as_user(client, shared_report["alice"]).get(url)
    assert any(
        s.startswith("DESCRIBE") for s in shared_report["alice_conn"].cursor_obj.executed
    )

    as_user(client, shared_report["bob"]).get(url)
    assert any(
        s.startswith("DESCRIBE") for s in shared_report["bob_conn"].cursor_obj.executed
    ), "Bob's DESCRIBE was served from another user's cache"
```

- [ ] **Step 2: Run it**

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/test_sharing_uses_viewer_credentials.py -v`
Expected: PASS. These assert existing behaviour rather than driving new code — that is the point. If any fails, something in Tasks 1–6 broke the property, and the fix belongs in that module.

If `ScriptedConnection` does not expose `cursor_obj.executed` in the shape used here, adjust the assertions to the real attribute rather than changing the fixture: the production behaviour is what is under test.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_sharing_uses_viewer_credentials.py
git commit -m "test: sharing shares definitions, never data"
```

---

## Task 8: Frontend workspace API and types

**Files:**
- Modify: `frontend/src/api/types.ts`, `frontend/src/api/reports.ts`
- Create: `frontend/src/api/workspaces.ts`, `frontend/src/workspaces/useWorkspaces.ts`
- Test: `frontend/src/api/workspaces.test.ts`

**Interfaces:**
- Produces:
  - `Role = "viewer" | "editor" | "admin"`, `WorkspaceSummary`, `WorkspaceMember`
  - `ReportSummary` gains `workspaceId`, `workspaceName`, `myRole`
  - `listWorkspaces`, `createWorkspace`, `renameWorkspace`, `deleteWorkspace`, `listMembers`, `addMember`, `setMemberRole`, `removeMember`, `moveReport`
  - `useWorkspaces()` — TanStack query keyed `["workspaces"]`
  - `atLeast(actual: Role, need: Role): boolean`

- [ ] **Step 1: Add the types**

In `frontend/src/api/types.ts`:

```ts
export type Role = "viewer" | "editor" | "admin";

export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: "personal" | "shared";
  myRole: Role;
  memberCount: number;
  reportCount: number;
}

export interface WorkspaceMember {
  userId: string;
  snowflakeUser: string;
  role: Role;
  isMe: boolean;
}
```

Add to `ReportSummary`:

```ts
  workspaceId: string;
  workspaceName: string;
  /** The caller's role in that workspace, so the UI can disable an action
   *  with a reason rather than letting the user discover it on a 403. */
  myRole: Role;
```

- [ ] **Step 2: Write the failing test**

```ts
// frontend/src/api/workspaces.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, atLeast, createWorkspace, listWorkspaces, moveReport } from "./workspaces";

let fetchMock: ReturnType<typeof vi.fn>;

function stub(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => text,
    json: async () => JSON.parse(text),
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => stub({ workspaces: [] }));
afterEach(() => vi.unstubAllGlobals());

describe("atLeast", () => {
  it("orders viewer below editor below admin", () => {
    expect(atLeast("admin", "editor")).toBe(true);
    expect(atLeast("editor", "editor")).toBe(true);
    expect(atLeast("viewer", "editor")).toBe(false);
  });

  it("mirrors the backend ladder exactly", () => {
    expect(atLeast("viewer", "viewer")).toBe(true);
    expect(atLeast("editor", "admin")).toBe(false);
  });
});

describe("workspace API", () => {
  it("lists workspaces", async () => {
    await listWorkspaces();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/workspaces");
  });

  it("creates a workspace", async () => {
    stub({ id: "w1", name: "Team" }, 201);
    await createWorkspace("Team");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/workspaces");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "Team" });
  });

  it("adds a member by Snowflake username", async () => {
    stub({ userId: "u1" }, 201);
    await addMember("w1", "BOB", "editor");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/workspaces/w1/members");
    expect(JSON.parse(init.body)).toEqual({ snowflakeUser: "BOB", role: "editor" });
  });

  it("encodes ids that would otherwise break the path", async () => {
    stub({ members: [] });
    await addMember("w/1", "BOB", "viewer");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/workspaces/w%2F1/members");
  });

  it("moves a report", async () => {
    stub({ id: "r1", workspaceId: "w2" });
    await moveReport("r1", "w2");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/reports/r1/move");
    expect(JSON.parse(init.body)).toEqual({ workspaceId: "w2" });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/api/workspaces.test.ts`
Expected: FAIL — cannot resolve `./workspaces`

- [ ] **Step 4: Write the client**

```ts
// frontend/src/api/workspaces.ts
import { apiFetch } from "./client";
import type { ReportDetail, Role, WorkspaceMember, WorkspaceSummary } from "./types";

/** Mirrors ROLES in backend/app/workspaces/roles.py. Weakest first; index is
 *  the rank. Kept in the same order so the two cannot drift apart silently. */
const ROLES: Role[] = ["viewer", "editor", "admin"];

/** Fails closed on anything unrecognised, matching `at_least` on the server:
 *  a garbage role satisfies nothing rather than sorting above every real one. */
export function atLeast(actual: Role, need: Role): boolean {
  const a = ROLES.indexOf(actual);
  const n = ROLES.indexOf(need);
  return a >= 0 && n >= 0 && a >= n;
}

const ws = (id: string) => `/api/workspaces/${encodeURIComponent(id)}`;

export function listWorkspaces(): Promise<{ workspaces: WorkspaceSummary[] }> {
  return apiFetch<{ workspaces: WorkspaceSummary[] }>("/api/workspaces");
}

export function createWorkspace(name: string): Promise<WorkspaceSummary> {
  return apiFetch<WorkspaceSummary>("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function renameWorkspace(id: string, name: string): Promise<WorkspaceSummary> {
  return apiFetch<WorkspaceSummary>(ws(id), {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function deleteWorkspace(id: string): Promise<void> {
  return apiFetch<void>(ws(id), { method: "DELETE" });
}

export function listMembers(id: string): Promise<{ members: WorkspaceMember[] }> {
  return apiFetch<{ members: WorkspaceMember[] }>(`${ws(id)}/members`);
}

export function addMember(
  id: string,
  snowflakeUser: string,
  role: Role,
): Promise<WorkspaceMember> {
  return apiFetch<WorkspaceMember>(`${ws(id)}/members`, {
    method: "POST",
    body: JSON.stringify({ snowflakeUser, role }),
  });
}

export function setMemberRole(
  id: string,
  userId: string,
  role: Role,
): Promise<WorkspaceMember> {
  return apiFetch<WorkspaceMember>(
    `${ws(id)}/members/${encodeURIComponent(userId)}`,
    { method: "PATCH", body: JSON.stringify({ role }) },
  );
}

export function removeMember(id: string, userId: string): Promise<void> {
  return apiFetch<void>(`${ws(id)}/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

export function moveReport(
  reportId: string,
  workspaceId: string,
): Promise<ReportDetail> {
  return apiFetch<ReportDetail>(
    `/api/reports/${encodeURIComponent(reportId)}/move`,
    { method: "POST", body: JSON.stringify({ workspaceId }) },
  );
}
```

```ts
// frontend/src/workspaces/useWorkspaces.ts
import { useQuery } from "@tanstack/react-query";
import { listWorkspaces } from "../api/workspaces";

/** Every workspace the caller belongs to, with their role in each.
 *
 *  Shared by the switcher, the create-report form and the move control, so it
 *  is one query rather than three -- and one cache entry to invalidate when
 *  membership changes. */
export function useWorkspaces() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: listWorkspaces,
  });
}
```

- [ ] **Step 5: Run the test and typecheck**

Run: `cd frontend && npx vitest run src/api/workspaces.test.ts && npm run typecheck`
Expected: PASS. `tsc -b` will flag every fixture building a `ReportSummary` without the three new fields — add them rather than making the fields optional; they are always present on the wire.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api frontend/src/workspaces
git commit -m "feat: workspace API client and role ladder mirror"
```

---

## Task 9: The workspace switcher and a scoped report list

**Files:**
- Create: `frontend/src/workspaces/WorkspaceSwitcher.tsx`
- Modify: `frontend/src/reports/ReportListPage.tsx`, `frontend/src/index.css`
- Test: `frontend/src/workspaces/WorkspaceSwitcher.test.tsx`, `frontend/src/reports/ReportListPage.test.tsx`

**Interfaces:**
- Consumes: `useWorkspaces`, `createWorkspace`, `atLeast`
- Produces: `<WorkspaceSwitcher value onChange onCreated onManageMembers />`

- [ ] **Step 1: Write the failing switcher test**

```tsx
// frontend/src/workspaces/WorkspaceSwitcher.test.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../api/types";
import WorkspaceSwitcher from "./WorkspaceSwitcher";

const WORKSPACES: WorkspaceSummary[] = [
  { id: "w0", name: "My reports", kind: "personal", myRole: "admin", memberCount: 1, reportCount: 2 },
  { id: "w1", name: "Team", kind: "shared", myRole: "viewer", memberCount: 4, reportCount: 7 },
];

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function stub(workspaces: WorkspaceSummary[]) {
  const text = JSON.stringify({ workspaces });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => text,
      json: async () => JSON.parse(text),
    }),
  );
}

beforeEach(() => stub(WORKSPACES));
afterEach(() => vi.unstubAllGlobals());

const props = {
  value: "w0",
  onChange: () => {},
  onCreated: () => {},
  onManageMembers: () => {},
};

describe("WorkspaceSwitcher", () => {
  it("lists every workspace I belong to", async () => {
    wrap(<WorkspaceSwitcher {...props} />);
    const select = (await screen.findByLabelText(/workspace/i)) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "My reports",
      "Team",
    ]);
  });

  it("reports a change", async () => {
    const onChange = vi.fn();
    wrap(<WorkspaceSwitcher {...props} onChange={onChange} />);
    await userEvent.selectOptions(await screen.findByLabelText(/workspace/i), "w1");
    expect(onChange).toHaveBeenCalledWith("w1");
  });

  it("shows my role in the selected workspace", async () => {
    wrap(<WorkspaceSwitcher {...props} value="w1" />);
    expect(await screen.findByText(/viewer/i)).toBeInTheDocument();
  });

  it("offers Members for a shared workspace", async () => {
    wrap(<WorkspaceSwitcher {...props} value="w1" />);
    expect(await screen.findByRole("button", { name: /members/i })).toBeInTheDocument();
  });

  it("does not offer Members for a personal workspace", async () => {
    wrap(<WorkspaceSwitcher {...props} value="w0" />);
    await screen.findByLabelText(/workspace/i);
    expect(screen.queryByRole("button", { name: /members/i })).toBeNull();
  });

  it("creates a workspace", async () => {
    const onCreated = vi.fn();
    wrap(<WorkspaceSwitcher {...props} onCreated={onCreated} />);
    await userEvent.click(await screen.findByRole("button", { name: /new workspace/i }));
    await userEvent.type(screen.getByLabelText(/workspace name/i), "Finance");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    expect(fetch).toHaveBeenCalledWith(
      "/api/workspaces",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/workspaces/WorkspaceSwitcher.test.tsx`
Expected: FAIL — cannot resolve `./WorkspaceSwitcher`

- [ ] **Step 3: Write the switcher**

```tsx
// frontend/src/workspaces/WorkspaceSwitcher.tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../api/client";
import { createWorkspace } from "../api/workspaces";
import { useWorkspaces } from "./useWorkspaces";

interface Props {
  value: string;
  onChange: (workspaceId: string) => void;
  onCreated: (workspaceId: string) => void;
  onManageMembers: () => void;
}

export default function WorkspaceSwitcher({
  value,
  onChange,
  onCreated,
  onManageMembers,
}: Props) {
  const workspaces = useWorkspaces();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => createWorkspace(name),
    onSuccess: (workspace) => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setCreating(false);
      setName("");
      onCreated(workspace.id);
    },
  });

  const rows = workspaces.data?.workspaces ?? [];
  const selected = rows.find((w) => w.id === value);

  return (
    <div className="workspace-switcher">
      <label>
        Workspace
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {rows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>

      {selected && (
        <span className="workspace-role">
          You are {selected.myRole === "admin" ? "an" : "a"} {selected.myRole} here
        </span>
      )}

      {/* Personal workspaces have no membership to manage -- that is what
          makes them personal -- so the control is absent rather than
          disabled. */}
      {selected?.kind === "shared" && (
        <button type="button" className="link" onClick={onManageMembers}>
          Members ({selected.memberCount})
        </button>
      )}

      {!creating && (
        <button type="button" className="secondary" onClick={() => setCreating(true)}>
          New workspace
        </button>
      )}
      {creating && (
        <form
          className="workspace-create"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <label>
            Workspace name
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <button type="submit" disabled={!name.trim() || create.isPending}>
            Create
          </button>
          <button type="button" className="link" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </form>
      )}
      {create.isError && (
        <p role="alert">
          {create.error instanceof ApiError
            ? create.error.message
            : "Could not create that workspace."}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Scope the report list**

In `frontend/src/reports/ReportListPage.tsx`: hold `const [workspaceId, setWorkspaceId] = useState<string | null>(null)`, render `<WorkspaceSwitcher>` in the header, and pass the id to `listReports`. Update `frontend/src/api/reports.ts`:

```ts
export function listReports(workspaceId?: string): Promise<{ reports: ReportSummary[] }> {
  const query = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : "";
  return apiFetch<{ reports: ReportSummary[] }>(`/api/reports${query}`);
}

export function createReport(
  definition: ReportDefinition,
  workspaceId?: string,
): Promise<ReportDetail> {
  return apiFetch<ReportDetail>("/api/reports", {
    method: "POST",
    body: JSON.stringify({ definition, workspaceId }),
  });
}
```

The report-list query key becomes `["reports", workspaceId]`, so switching workspace refetches instead of showing the previous one's list.

Add a builder-level test to `ReportListPage.test.tsx` asserting that selecting a workspace refetches with `?workspace=`, and that "New report" sends the selected `workspaceId`.

- [ ] **Step 5: Styles**

```css
.workspace-switcher {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.workspace-role {
  font-size: 0.8125rem;
  color: var(--ink-muted);
}
.workspace-create {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
@media (max-width: 768px) {
  .workspace-switcher {
    align-items: stretch;
    flex-direction: column;
  }
}
```

- [ ] **Step 6: Run the frontend suite**

Run: `cd frontend && npx vitest run && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "feat: workspace switcher and a workspace-scoped report list"
```

---

## Task 10: The members panel

**Files:**
- Create: `frontend/src/workspaces/MembersPanel.tsx`
- Modify: `frontend/src/reports/ReportListPage.tsx`, `frontend/src/index.css`
- Test: `frontend/src/workspaces/MembersPanel.test.tsx`

**Interfaces:**
- Consumes: `listMembers`, `addMember`, `setMemberRole`, `removeMember`, `atLeast`
- Produces: `<MembersPanel workspaceId myRole onClose />`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/workspaces/MembersPanel.test.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceMember } from "../api/types";
import MembersPanel from "./MembersPanel";

const MEMBERS: WorkspaceMember[] = [
  { userId: "u0", snowflakeUser: "ALICE", role: "admin", isMe: true },
  { userId: "u1", snowflakeUser: "BOB", role: "viewer", isMe: false },
];

let fetchMock: ReturnType<typeof vi.fn>;

function stub(members: WorkspaceMember[]) {
  const text = JSON.stringify({ members });
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => text,
    json: async () => JSON.parse(text),
  });
  vi.stubGlobal("fetch", fetchMock);
}

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => stub(MEMBERS));
afterEach(() => vi.unstubAllGlobals());

describe("MembersPanel", () => {
  it("lists members and marks which one is me", async () => {
    wrap(<MembersPanel workspaceId="w1" myRole="admin" onClose={() => {}} />);
    expect(await screen.findByText("ALICE")).toBeInTheDocument();
    expect(screen.getByText("BOB")).toBeInTheDocument();
    expect(screen.getByText(/you/i)).toBeInTheDocument();
  });

  it("lets an admin add a member", async () => {
    wrap(<MembersPanel workspaceId="w1" myRole="admin" onClose={() => {}} />);
    await userEvent.type(
      await screen.findByLabelText(/snowflake username/i),
      "CAROL",
    );
    await userEvent.selectOptions(screen.getByLabelText(/role for the new/i), "editor");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("/api/workspaces/w1/members");
    expect(JSON.parse(init.body)).toEqual({ snowflakeUser: "CAROL", role: "editor" });
  });

  it("shows a non-admin the list without any way to change it", async () => {
    wrap(<MembersPanel workspaceId="w1" myRole="viewer" onClose={() => {}} />);
    expect(await screen.findByText("ALICE")).toBeInTheDocument();
    expect(screen.queryByLabelText(/snowflake username/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /remove BOB/i })).toBeNull();
    expect(screen.getByText(/only an admin/i)).toBeInTheDocument();
  });

  it("disables the last admin's controls and says why", async () => {
    stub([{ userId: "u0", snowflakeUser: "ALICE", role: "admin", isMe: true }]);
    wrap(<MembersPanel workspaceId="w1" myRole="admin" onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: /remove ALICE/i })).toBeDisabled();
    expect(screen.getByText(/last admin/i)).toBeInTheDocument();
  });

  it("does not disable an admin's controls when there are two", async () => {
    stub([
      { userId: "u0", snowflakeUser: "ALICE", role: "admin", isMe: true },
      { userId: "u1", snowflakeUser: "BOB", role: "admin", isMe: false },
    ]);
    wrap(<MembersPanel workspaceId="w1" myRole="admin" onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: /remove ALICE/i })).toBeEnabled();
  });

  it("changes a role", async () => {
    wrap(<MembersPanel workspaceId="w1" myRole="admin" onClose={() => {}} />);
    await userEvent.selectOptions(
      await screen.findByLabelText(/role for BOB/i),
      "editor",
    );
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("/api/workspaces/w1/members/u1");
    expect(JSON.parse(init.body)).toEqual({ role: "editor" });
  });

  it("surfaces a rejected add rather than failing silently", async () => {
    wrap(<MembersPanel workspaceId="w1" myRole="admin" onClose={() => {}} />);
    await screen.findByText("ALICE");
    const body = JSON.stringify({
      code: "REPORT_INVALID",
      message: "BOB is already a member.",
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => body,
      json: async () => JSON.parse(body),
    });
    await userEvent.type(screen.getByLabelText(/snowflake username/i), "BOB");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already a member/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/workspaces/MembersPanel.test.tsx`
Expected: FAIL — cannot resolve `./MembersPanel`

- [ ] **Step 3: Write the panel**

```tsx
// frontend/src/workspaces/MembersPanel.tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../api/client";
import type { Role } from "../api/types";
import { addMember, listMembers, removeMember, setMemberRole } from "../api/workspaces";

const ROLE_OPTIONS: Role[] = ["viewer", "editor", "admin"];

interface Props {
  workspaceId: string;
  myRole: Role;
  onClose: () => void;
}

export default function MembersPanel({ workspaceId, myRole, onClose }: Props) {
  const queryClient = useQueryClient();
  const members = useQuery({
    queryKey: ["workspace-members", workspaceId],
    queryFn: () => listMembers(workspaceId),
  });
  const [username, setUsername] = useState("");
  const [newRole, setNewRole] = useState<Role>("viewer");

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["workspace-members", workspaceId] });
    // Membership changes the member count shown in the switcher.
    queryClient.invalidateQueries({ queryKey: ["workspaces"] });
  };

  const add = useMutation({
    mutationFn: () => addMember(workspaceId, username.trim(), newRole),
    onSuccess: () => {
      setUsername("");
      refresh();
    },
  });
  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      setMemberRole(workspaceId, userId, role),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => removeMember(workspaceId, userId),
    onSuccess: refresh,
  });

  const rows = members.data?.members ?? [];
  const admins = rows.filter((m) => m.role === "admin").length;
  const canManage = myRole === "admin";
  const failure = add.error ?? changeRole.error ?? remove.error;

  return (
    <section className="members-panel" aria-label="Workspace members">
      <header>
        <h3>Members</h3>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </header>

      {members.isLoading && <p className="tile-hint">Loading members…</p>}
      {members.isError && <p role="alert">Could not load members.</p>}

      <ul className="member-list">
        {rows.map((member) => {
          // The server refuses to remove or demote the last admin. Disabling
          // with a stated reason beats letting the user try and be rejected.
          const isLastAdmin = member.role === "admin" && admins === 1;
          return (
            <li key={member.userId}>
              <span className="member-name">
                {member.snowflakeUser}
                {member.isMe && <small> (you)</small>}
              </span>
              {canManage ? (
                <>
                  <label>
                    Role for {member.snowflakeUser}
                    <select
                      value={member.role}
                      disabled={isLastAdmin}
                      onChange={(e) =>
                        changeRole.mutate({
                          userId: member.userId,
                          role: e.target.value as Role,
                        })
                      }
                    >
                      {ROLE_OPTIONS.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="link"
                    disabled={isLastAdmin}
                    onClick={() => remove.mutate(member.userId)}
                  >
                    Remove {member.snowflakeUser}
                  </button>
                  {isLastAdmin && (
                    <small className="tile-hint">
                      The last admin cannot be removed or demoted. Promote
                      someone else first.
                    </small>
                  )}
                </>
              ) : (
                <span className="member-role">{member.role}</span>
              )}
            </li>
          );
        })}
      </ul>

      {canManage ? (
        <form
          className="member-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (username.trim()) add.mutate();
          }}
        >
          <label>
            Snowflake username
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label>
            Role for the new member
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
              {ROLE_OPTIONS.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={!username.trim() || add.isPending}>
            Add
          </button>
        </form>
      ) : (
        <p className="tile-hint">
          Only an admin can change who is in this workspace.
        </p>
      )}

      {failure && (
        <p role="alert">
          {failure instanceof ApiError ? failure.message : "That did not work."}
        </p>
      )}

      <p className="tile-hint">
        Members see this workspace's reports, and each one runs on their own
        Snowflake credentials. Adding someone here does not grant them access
        to any data their Snowflake role cannot already read.
      </p>
    </section>
  );
}
```

Render it from `ReportListPage` in the existing `.panel-overlay` wrapper, opened by the switcher's Members button.

- [ ] **Step 4: Styles**

```css
.members-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: min(420px, 90vw);
}
.members-panel header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.member-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}
.member-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-height: 24px;
}
.member-name {
  flex: 1;
  overflow-wrap: anywhere;
}
.member-add {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
```

- [ ] **Step 5: Run the frontend suite**

Run: `cd frontend && npx vitest run && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src
git commit -m "feat: members panel with role management"
```

---

## Task 11: Role-aware affordances in the builder

A viewer opening a shared report must not be able to reach Save and be told no. The controls are disabled with a stated reason, not hidden — hiding them makes the report look broken rather than read-only.

**Files:**
- Modify: `frontend/src/reports/BuilderPage.tsx`, `frontend/src/index.css`
- Test: `frontend/src/reports/BuilderPage.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
describe("BuilderPage roles", () => {
  beforeEach(() => stubApi());

  it("lets an editor save", async () => {
    getMock.mockResolvedValue({ ...detail, myRole: "editor" });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: "select v1" }));
    const axis = await screen.findByRole("region", { name: "Axis" });
    await userEvent.click(within(axis).getByRole("button", { name: /remove C\.REGION/i }));
    expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();
  });

  it("disables Save for a viewer and says why", async () => {
    getMock.mockResolvedValue({ ...detail, myRole: "viewer" });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    expect(screen.getByText(/read-only|viewer/i)).toBeInTheDocument();
  });

  it("does not offer Import to a viewer", async () => {
    getMock.mockResolvedValue({ ...detail, myRole: "viewer" });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    // Import creates a report; a viewer has nowhere to put one here.
    expect(screen.queryByRole("button", { name: /^import$/i })).toBeNull();
  });

  it("still lets a viewer export", async () => {
    getMock.mockResolvedValue({ ...detail, myRole: "viewer" });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    expect(screen.getByRole("button", { name: /^export$/i })).toBeEnabled();
  });

  it("offers Move only to workspaces I can write to", async () => {
    getMock.mockResolvedValue({ ...detail, myRole: "editor" });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await userEvent.click(await screen.findByRole("button", { name: /move/i }));
    const select = (await screen.findByLabelText(/move to/i)) as HTMLSelectElement;
    // stubApi's workspace list has one viewer-role workspace, which must not
    // be offered as a destination.
    expect([...select.options].map((o) => o.textContent)).not.toContain("Read only");
  });
});
```

Extend `stubApi` in that file to answer `/api/workspaces` with three rows: personal (admin), "Team" (editor) and "Read only" (viewer). Add `myRole` to the `detail` fixture.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/reports/BuilderPage.test.tsx`
Expected: FAIL — `myRole` is unread and every control is enabled.

- [ ] **Step 3: Implement**

In `BuilderPage.tsx`, read `report.data.myRole`, derive `const canEdit = atLeast(myRole, "editor")`, and:

- `disabled={!canEdit || !dirty || save.isPending}` on Save, with a sibling hint rendered when `!canEdit`:
  ```tsx
  {!canEdit && (
    <p className="tile-hint">
      You have the {myRole} role in this workspace, so this report is
      read-only for you. Its data still runs on your own Snowflake
      credentials.
    </p>
  )}
  ```
- Import button rendered only when `canEdit`; Export always.
- Field placement, well removal, filter and hierarchy editing all guarded by `canEdit`.
- A Move control listing `useWorkspaces()` rows filtered by `atLeast(w.myRole, "editor")`, calling `moveReport` and invalidating `["reports"]` and `["report", reportId]`.

- [ ] **Step 4: Run the frontend suite**

Run: `cd frontend && npx vitest run && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat: role-aware builder affordances and report move"
```

---

## Task 12: Integration, docs, and an unstubbed browser pass

**Files:**
- Create: `backend/tests/integration/test_sharing_it.py`, `docs/superpowers/manual-passes/YYYY-MM-DD-workspaces.md`
- Modify: `README.md`

- [ ] **Step 1: Add the integration test**

```python
# backend/tests/integration/test_sharing_it.py
"""Sharing against the real account.

A second Snowflake login is needed to prove the property end to end. When
SEMANTICUI_IT_USER_B is unset the module skips with a reason that says what is
missing -- a skip is not a pass, and silence here would read as coverage that
does not exist.
"""
import os

import pytest

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not (os.environ.get("SEMANTICUI_IT_ACCOUNT") and os.environ.get("SEMANTICUI_IT_USER_B")),
        reason="needs SEMANTICUI_IT_USER_B / _PASSWORD_B: a second real Snowflake login",
    ),
]


def test_two_real_users_share_a_definition_and_not_a_connection():
    """Both users open the same report; each query runs on its own connection.

    Written to be run by hand when a second account is available. It asserts
    the two connections are distinct objects and that each executed only its
    own statements.
    """
    from app.snowflake import connect as sf_connect

    a = sf_connect.connect_dev(
        account=os.environ["SEMANTICUI_IT_ACCOUNT"],
        user=os.environ["SEMANTICUI_IT_USER"],
        authenticator="password",
        password=os.environ["SEMANTICUI_IT_PASSWORD"],
    )
    b = sf_connect.connect_dev(
        account=os.environ["SEMANTICUI_IT_ACCOUNT"],
        user=os.environ["SEMANTICUI_IT_USER_B"],
        authenticator="password",
        password=os.environ["SEMANTICUI_IT_PASSWORD_B"],
    )
    try:
        assert a is not b
        account_a, user_a = sf_connect.probe_identity(a)
        account_b, user_b = sf_connect.probe_identity(b)
        assert user_a != user_b, "both logins resolved to the same Snowflake user"
        assert account_a == account_b, "sharing is confined to one account"
    finally:
        a.close()
        b.close()
```

Run: `cd backend && .venv/Scripts/python.exe -m pytest tests/integration -m integration -v`
Expected: the existing 16 pass; this one **skips** unless a second login is configured. Report the skip honestly rather than describing it as covered.

- [ ] **Step 2: Unstubbed browser pass**

Start the backend and frontend, sign in with real credentials, and drive the **live** API — no `page.route` stubs. Record results in `docs/superpowers/manual-passes/YYYY-MM-DD-workspaces.md`, including a section stating what was *not* covered.

1. Sign in → the switcher shows "My reports" and nothing else.
2. Create a workspace "Team" → it appears, and you are its admin.
3. Create a report in Team → it appears only under Team, not under My reports.
4. Open Members → you are the only one, and your Remove button is disabled with the last-admin reason.
5. Add a member by Snowflake username → they appear with the chosen role.
6. Try to remove yourself → refused, with the last-admin message.
7. Promote the other member to admin, then remove yourself → succeeds; the workspace disappears from your switcher.
8. Try to open one of its reports by URL → 404, not 403.
9. Move a report from My reports to Team → it moves; the switcher counts update.
10. Rename Team → the switcher updates. Try to rename My reports → refused.
11. Delete Team → its reports go with it, and the UI named the count first.
12. Resize to 1440 / 1280 / 1024 / 768 / 390px → the switcher and members panel stay usable, no horizontal overflow.

- [ ] **Step 3: Update the README**

Add a "Workspaces and sharing" section covering: workspaces as the only unit of sharing; the three roles and what each may do; that a personal workspace exists per user and refuses members; the four guard rails; the 404-vs-403 rule and why they differ; and — stated plainly, because it is the property the whole feature rests on — that sharing shares report definitions and never data, with a viewer whose Snowflake role cannot read the view seeing the report's shape and none of its numbers. Point at `app/workspaces/access.py` as the single place authorization is decided.

- [ ] **Step 4: Full verification**

Run, in order:

    cd backend && .venv/Scripts/python.exe -m pytest -q
    cd backend && .venv/Scripts/python.exe -m pytest -q -m integration
    cd frontend && npx vitest run && npm run typecheck && npm run lint

Expected: all green, with the second-login integration test skipping if unconfigured.

- [ ] **Step 5: Commit**

```bash
git add backend/tests/integration README.md docs/superpowers/manual-passes/
git commit -m "test: sharing integration coverage, docs, and an unstubbed browser pass"
```

---

## Done When

- A report can be opened by every member of its workspace and by nobody else, with a non-member receiving 404 and an under-privileged member 403.
- `get_owned_report` no longer exists; `require_access` is the only path to a report.
- A report saved before this branch opens from its owner's personal workspace, and `reports.workspace_id` is NOT NULL.
- The last admin of a workspace cannot be removed or demoted, by anyone including themselves.
- A personal workspace refuses members, renames and deletion.
- Two members of one workspace open the same definition, and each queries on their own Snowflake connection — asserted, not assumed.
- The layout holds at all five breakpoints and every control has a keyboard path.
