# Session Context and Finding Your Work — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user pick their Snowflake account at login, switch role and warehouse from the profile menu with the choice remembered, and find their work among hundreds of items through search, recents, favourites and a clearable role facet.

**Architecture:** Membership stays the single rule for access and visibility — every new filter narrows a set the user may already see, never widens it. Finding is a shared library layer (`app/library/`) used identically by reports and explores. Execution context (account, role, warehouse) is a session property applied with `USE ROLE`/`USE WAREHOUSE` on the cached connection rather than a reconnect.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 (`Mapped`/`mapped_column`), Alembic, pytest; React 19 + TypeScript strict, TanStack Query, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-20-session-context-and-finding-design.md`

## Global Constraints

- Every query runs on the caller's own Snowflake connection. No service account, ever.
- Values are bound, never SQL text. Identifiers go through `quote_ident`.
- Never log data: field references, counts, durations and query ids are fine; row values, filter values and tokens are not. `tests/test_logging.py` enforces this.
- 404 for non-members, 403 for low roles. `require_owned` / `require_workspace` remain the only authorization gate — no new gate.
- `frontend/src/query/palette.ts` is order-sensitive: never modify or reorder it.
- Docs ship with code, in the same PR.
- Backend commands run from `backend/`: tests `.venv/Scripts/python.exe -m pytest -q`, lint `.venv/Scripts/python.exe -m ruff check app tests`.
- Frontend commands run from `frontend/`: `npm test -- --run`, `npx tsc --noEmit`, `npm run lint`, `npm run build`.
- Every commit leaves both suites green.

---

## File Structure

**Backend — new**

| File | Responsibility |
|---|---|
| `app/library/__init__.py` | package marker |
| `app/library/state.py` | favourites and recents over `user_item_state` |
| `app/library/search.py` | the search/facet/sort filter both list endpoints apply |
| `app/library/routes.py` | favourite toggle + recent-view recording endpoints |
| `app/session/__init__.py` | package marker |
| `app/session/context.py` | read/apply role and warehouse on a connection |
| `app/session/routes.py` | list roles, list warehouses, set context |
| `migrations/versions/0007_session_context_and_library.py` | the one migration |

**Backend — modified**

| File | Change |
|---|---|
| `app/db/models.py` | `User.last_role/last_warehouse`; `Report`/`SavedExplore` stamps; `UserItemState` |
| `app/config.py` | `snowflake_accounts` |
| `app/auth/routes.py` | account on login/callback, apply remembered context, expose accounts |
| `app/auth/oauth.py` | carry the account in the state entry |
| `app/reports/service.py` | list accepts library filters; stamp on create/update |
| `app/reports/routes.py` | pass query params through |
| `app/explores/service.py` | same as reports |
| `app/explores/routes.py` | same as reports |
| `app/main.py` | register the two new routers |

**Frontend — new**

| File | Responsibility |
|---|---|
| `src/api/library.ts` | favourite/recent/list query params |
| `src/api/session.ts` | roles, warehouses, set context |
| `src/library/useLibraryQuery.ts` | the browse state hook (search, facet, sort) |
| `src/library/SearchBar.tsx` | debounced search input |
| `src/library/FacetChips.tsx` | clearable "Role: ANALYST ✕" chips + result count |
| `src/library/FavoriteStar.tsx` | pin toggle |
| `src/session/useSessionContext.ts` | current context + switch mutation |
| `src/session/ProfileMenu.tsx` | the role/warehouse switcher |
| `src/auth/AccountPicker.tsx` | login dropdown |

**Frontend — modified**: `src/reports/ReportListPage.tsx`, `src/explorer/ExplorerPage.tsx` (list region), `src/shell/AppShell.tsx`, `src/auth/LoginPage.tsx`.

---

### Task 1: Schema — remembered context, item stamps, library state

**Files:**
- Modify: `backend/app/db/models.py`
- Create: `backend/migrations/versions/0007_session_context_and_library.py`
- Test: `backend/tests/test_migration_0007.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `User.last_role: str | None`, `User.last_warehouse: str | None`; `Report.snowflake_role`, `Report.snowflake_warehouse`, `SavedExplore.snowflake_role`, `SavedExplore.snowflake_warehouse` (all `str | None`); `UserItemState(user_id, item_type, item_id, favorite: bool, last_viewed_at: datetime | None)` with unique `(user_id, item_type, item_id)`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_migration_0007.py
"""0007 adds context and library state without disturbing what exists."""

from sqlalchemy import inspect

from app.db.models import Report, SavedExplore, User, UserItemState


def test_the_new_columns_are_all_optional(db):
    # Every column added is nullable or defaulted, so a row written
    # before this migration stays readable after it.
    user = User(snowflake_account="ACME", snowflake_user="ALICE")
    db.add(user)
    db.commit()
    assert user.last_role is None
    assert user.last_warehouse is None


def test_user_item_state_is_unique_per_user_and_item(db):
    import uuid

    user = User(snowflake_account="ACME", snowflake_user="ALICE")
    db.add(user)
    db.commit()
    item = uuid.uuid4()
    db.add(UserItemState(user_id=user.id, item_type="report", item_id=item))
    db.commit()
    row = db.query(UserItemState).one()
    assert row.favorite is False
    assert row.last_viewed_at is None


def test_items_carry_a_nullable_context_stamp(db):
    assert "snowflake_role" in inspect(Report).columns
    assert "snowflake_warehouse" in inspect(Report).columns
    assert "snowflake_role" in inspect(SavedExplore).columns
    assert "snowflake_warehouse" in inspect(SavedExplore).columns
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/test_migration_0007.py -q`
Expected: FAIL — `ImportError: cannot import name 'UserItemState'`

- [ ] **Step 3: Add the models**

```python
# backend/app/db/models.py — inside class User
    #: The execution context this user last chose, replayed at next
    #: login. NULL means "never chose"; the token's role and the
    #: account default warehouse apply instead.
    last_role: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_warehouse: Mapped[str | None] = mapped_column(String(255), nullable=True)

# inside class Report AND class SavedExplore (identical pair)
    #: Provenance: the role and warehouse this was last saved under.
    #: A facet, never a permission -- membership decides who may read it.
    snowflake_role: Mapped[str | None] = mapped_column(String(255), nullable=True)
    snowflake_warehouse: Mapped[str | None] = mapped_column(String(255), nullable=True)


class UserItemState(Base):
    """One user's relationship to one item: pinned, and last opened.

    Recents and favourites are the same concern -- what this person has
    done with this item -- so they share a row rather than two tables
    that must be kept in step. `item_type` is a string because reports
    and explores are separate tables and a column per kind would grow
    with every new kind.
    """

    __tablename__ = "user_item_state"
    __table_args__ = (
        UniqueConstraint("user_id", "item_type", "item_id", name="uq_user_item_state"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True)
    item_type: Mapped[str] = mapped_column(String(16))
    item_id: Mapped[uuid.UUID] = mapped_column(Uuid, index=True)
    favorite: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    last_viewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
```

Add `Boolean` to the `sqlalchemy` import line.

- [ ] **Step 4: Write the migration**

```python
# backend/migrations/versions/0007_session_context_and_library.py
"""session context and library state

Revision ID: 0007
Revises: 0006
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("last_role", sa.String(255), nullable=True))
    op.add_column("users", sa.Column("last_warehouse", sa.String(255), nullable=True))
    for table in ("reports", "saved_explores"):
        op.add_column(table, sa.Column("snowflake_role", sa.String(255), nullable=True))
        op.add_column(
            table, sa.Column("snowflake_warehouse", sa.String(255), nullable=True)
        )
    op.create_table(
        "user_item_state",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("item_type", sa.String(16), nullable=False),
        sa.Column("item_id", sa.Uuid(), nullable=False),
        sa.Column("favorite", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("last_viewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("user_id", "item_type", "item_id", name="uq_user_item_state"),
    )
    op.create_index("ix_user_item_state_user_id", "user_item_state", ["user_id"])
    op.create_index("ix_user_item_state_item_id", "user_item_state", ["item_id"])
    op.create_index(
        "ix_user_item_state_recent", "user_item_state", ["user_id", "last_viewed_at"]
    )


def downgrade() -> None:
    op.drop_table("user_item_state")
    for table in ("reports", "saved_explores"):
        op.drop_column(table, "snowflake_warehouse")
        op.drop_column(table, "snowflake_role")
    op.drop_column("users", "last_warehouse")
    op.drop_column("users", "last_role")
```

- [ ] **Step 5: Run tests and lint**

Run: `.venv/Scripts/python.exe -m pytest -q && .venv/Scripts/python.exe -m ruff check app tests`
Expected: all pass, "All checks passed!"

- [ ] **Step 6: Commit**

```bash
git add backend/app/db/models.py backend/migrations/versions/0007_session_context_and_library.py backend/tests/test_migration_0007.py
git commit -m "feat(db): remembered context, item stamps and library state"
```

---

### Task 2: Favourites and recents

**Files:**
- Create: `backend/app/library/__init__.py`, `backend/app/library/state.py`
- Test: `backend/tests/test_library_state.py`

**Interfaces:**
- Consumes: `UserItemState` from Task 1.
- Produces:
  - `set_favorite(db, user_id: uuid.UUID, item_type: str, item_id: uuid.UUID, favorite: bool) -> None`
  - `record_view(db, user_id, item_type, item_id) -> None`
  - `favorite_ids(db, user_id, item_type) -> set[uuid.UUID]`
  - `recent_order(db, user_id, item_type) -> dict[uuid.UUID, datetime]`
  - `forget_item(db, item_type, item_id) -> None`
  - `ITEM_TYPES = ("report", "explore")`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_library_state.py
"""Favourites and recents: per user, and gone when the item is."""

import uuid

import pytest

from app.db.models import User, UserItemState
from app.library import state


def make_user(db, name="ALICE"):
    user = User(snowflake_account="ACME", snowflake_user=name)
    db.add(user)
    db.commit()
    return user


def test_favorite_toggles_and_is_idempotent(db):
    user = make_user(db)
    item = uuid.uuid4()
    state.set_favorite(db, user.id, "report", item, True)
    state.set_favorite(db, user.id, "report", item, True)
    assert state.favorite_ids(db, user.id, "report") == {item}
    assert db.query(UserItemState).count() == 1
    state.set_favorite(db, user.id, "report", item, False)
    assert state.favorite_ids(db, user.id, "report") == set()


def test_one_users_favorites_are_invisible_to_another(db):
    alice, bob = make_user(db), make_user(db, "BOB")
    item = uuid.uuid4()
    state.set_favorite(db, alice.id, "report", item, True)
    assert state.favorite_ids(db, bob.id, "report") == set()


def test_recording_a_view_moves_it_to_the_front(db):
    user = make_user(db)
    first, second = uuid.uuid4(), uuid.uuid4()
    state.record_view(db, user.id, "report", first)
    state.record_view(db, user.id, "report", second)
    state.record_view(db, user.id, "report", first)
    order = state.recent_order(db, user.id, "report")
    assert order[first] > order[second]


def test_viewing_does_not_clear_a_favorite(db):
    user = make_user(db)
    item = uuid.uuid4()
    state.set_favorite(db, user.id, "report", item, True)
    state.record_view(db, user.id, "report", item)
    assert state.favorite_ids(db, user.id, "report") == {item}


def test_forgetting_an_item_removes_every_users_row(db):
    alice, bob = make_user(db), make_user(db, "BOB")
    item = uuid.uuid4()
    state.set_favorite(db, alice.id, "report", item, True)
    state.record_view(db, bob.id, "report", item)
    state.forget_item(db, "report", item)
    assert db.query(UserItemState).count() == 0


def test_an_unknown_item_type_is_refused(db):
    user = make_user(db)
    with pytest.raises(ValueError):
        state.set_favorite(db, user.id, "dashboard", uuid.uuid4(), True)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/test_library_state.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.library'`

- [ ] **Step 3: Implement**

```python
# backend/app/library/state.py
"""What a user has pinned, and what they last opened.

Recents cost the user nothing -- they are a side effect of opening an
item -- and cover the case that actually matters at scale: of a hundred
saved items a person returns to about ten. Favourites cover the rest,
explicitly. Both live on one row because both answer the same question:
what is this person's relationship to this item.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import UserItemState

#: The item kinds that can be pinned or viewed. Guarded rather than
#: free-form so a typo cannot quietly create a parallel namespace.
ITEM_TYPES = ("report", "explore")


def _check(item_type: str) -> str:
    if item_type not in ITEM_TYPES:
        raise ValueError(f"unknown item type {item_type!r}")
    return item_type


def _row(db: Session, user_id, item_type: str, item_id) -> UserItemState:
    row = db.scalar(
        select(UserItemState).where(
            UserItemState.user_id == user_id,
            UserItemState.item_type == _check(item_type),
            UserItemState.item_id == item_id,
        )
    )
    if row is None:
        row = UserItemState(user_id=user_id, item_type=item_type, item_id=item_id)
        db.add(row)
    return row


def set_favorite(db: Session, user_id, item_type: str, item_id, favorite: bool) -> None:
    _row(db, user_id, item_type, item_id).favorite = favorite
    db.commit()


def record_view(db: Session, user_id, item_type: str, item_id) -> None:
    _row(db, user_id, item_type, item_id).last_viewed_at = datetime.now(timezone.utc)
    db.commit()


def favorite_ids(db: Session, user_id, item_type: str) -> set[uuid.UUID]:
    return set(
        db.scalars(
            select(UserItemState.item_id).where(
                UserItemState.user_id == user_id,
                UserItemState.item_type == _check(item_type),
                UserItemState.favorite.is_(True),
            )
        )
    )


def recent_order(db: Session, user_id, item_type: str) -> dict[uuid.UUID, datetime]:
    rows = db.execute(
        select(UserItemState.item_id, UserItemState.last_viewed_at).where(
            UserItemState.user_id == user_id,
            UserItemState.item_type == _check(item_type),
            UserItemState.last_viewed_at.is_not(None),
        )
    ).all()
    return {item_id: seen for item_id, seen in rows}


def forget_item(db: Session, item_type: str, item_id) -> None:
    """Drop every user's state for an item being deleted.

    Called from the delete path rather than left to a foreign key: the
    reference is polymorphic, so the database cannot cascade it.
    """
    db.query(UserItemState).filter(
        UserItemState.item_type == _check(item_type),
        UserItemState.item_id == item_id,
    ).delete()
    db.commit()
```

- [ ] **Step 4: Run tests**

Run: `.venv/Scripts/python.exe -m pytest tests/test_library_state.py -q`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add backend/app/library backend/tests/test_library_state.py
git commit -m "feat(library): favourites and recents on one state row"
```

---

### Task 3: The shared search filter

**Files:**
- Create: `backend/app/library/search.py`
- Test: `backend/tests/test_library_search.py`

**Interfaces:**
- Consumes: `state.favorite_ids`, `state.recent_order` from Task 2.
- Produces: `LibraryQuery(q: str | None, favorite: bool, role: str | None, sort: str)` (a pydantic `BaseModel`) and `apply(query, model, params: LibraryQuery, workspace_model)` returning a narrowed SQLAlchemy select, plus `order_items(items, params, recents, favorites)` returning the sorted list.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_library_search.py
"""The facet narrows a membership-scoped set. It can never widen one."""

from app.library.search import LibraryQuery, apply, order_items


class Item:
    def __init__(self, id, name, role=None, updated_at=0):
        self.id, self.name = id, name
        self.snowflake_role, self.updated_at = role, updated_at


def test_defaults_change_nothing():
    params = LibraryQuery()
    assert params.q is None and params.favorite is False
    assert params.role is None and params.sort == "recent"


def test_recent_sort_puts_last_viewed_first_then_the_rest():
    a, b, c = Item(1, "A"), Item(2, "B"), Item(3, "C")
    ordered = order_items(
        [a, b, c], LibraryQuery(sort="recent"), recents={3: 10, 1: 5}, favorites=set()
    )
    assert [i.id for i in ordered] == [3, 1, 2]


def test_name_sort_is_case_insensitive():
    items = [Item(1, "beta"), Item(2, "Alpha")]
    ordered = order_items(items, LibraryQuery(sort="name"), recents={}, favorites=set())
    assert [i.id for i in ordered] == [2, 1]


def test_favorites_float_above_everything_on_recent_sort():
    a, b = Item(1, "A"), Item(2, "B")
    ordered = order_items(
        [a, b], LibraryQuery(sort="recent"), recents={1: 99}, favorites={2}
    )
    assert [i.id for i in ordered] == [2, 1]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/test_library_search.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.library.search'`

- [ ] **Step 3: Implement**

```python
# backend/app/library/search.py
"""One filter, applied identically to reports and explores.

Both lists browse the same way, so the query lives here rather than
twice. Everything here NARROWS: it is applied after the membership
join, so a facet can hide something the caller may see and can never
reveal something they may not.
"""

from typing import Any, Literal

from pydantic import BaseModel
from sqlalchemy import func, or_, select

from app.db.models import Workspace


class LibraryQuery(BaseModel):
    #: Free text over name, semantic view and workspace name.
    q: str | None = None
    favorite: bool = False
    #: The provenance facet. A visible, clearable chip in the UI -- never
    #: a permission.
    role: str | None = None
    sort: Literal["recent", "name", "updated"] = "recent"


def apply(query, model: Any, params: LibraryQuery) -> Any:
    """Narrow a select of `model` (Report or SavedExplore)."""
    if params.q:
        # Bound, never interpolated: the value reaches the driver as a
        # parameter even though it is a LIKE pattern.
        pattern = f"%{params.q.strip().lower()}%"
        query = query.join(Workspace, Workspace.id == model.workspace_id).where(
            or_(
                func.lower(model.name).like(pattern),
                func.lower(model.view_name).like(pattern),
                func.lower(Workspace.name).like(pattern),
            )
        )
    if params.role:
        query = query.where(func.upper(model.snowflake_role) == params.role.upper())
    return query


def order_items(items: list, params: LibraryQuery, recents: dict, favorites: set) -> list:
    """Sort in Python, because 'recent' and 'favourite' live in a
    per-user table the item query does not join."""
    if params.sort == "name":
        return sorted(items, key=lambda i: i.name.lower())
    if params.sort == "updated":
        return sorted(items, key=lambda i: i.updated_at, reverse=True)
    # recent: pinned first, then last-opened, then everything else by
    # its own recency -- so a fresh list is useful before anyone has
    # opened or pinned anything.
    def key(item):
        return (
            0 if item.id in favorites else 1,
            -(recents.get(item.id).timestamp() if recents.get(item.id) else 0)
            if not isinstance(recents.get(item.id), (int, float))
            else -recents[item.id],
        )

    known = [i for i in items if i.id in favorites or i.id in recents]
    rest = sorted(items, key=lambda i: i.updated_at, reverse=True)
    rest = [i for i in rest if i not in known]
    return sorted(known, key=key) + rest


def filtered_ids(favorites: set, params: LibraryQuery, items: list) -> list:
    """Apply the favourite-only facet, which lives outside SQL."""
    if not params.favorite:
        return items
    return [i for i in items if i.id in favorites]


__all__ = ["LibraryQuery", "apply", "order_items", "filtered_ids", "select"]
```

- [ ] **Step 4: Run tests**

Run: `.venv/Scripts/python.exe -m pytest tests/test_library_search.py -q`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add backend/app/library/search.py backend/tests/test_library_search.py
git commit -m "feat(library): the shared search, facet and sort filter"
```

---

### Task 4: Wire finding into reports and explores

**Files:**
- Modify: `backend/app/reports/service.py`, `backend/app/reports/routes.py`, `backend/app/explores/service.py`, `backend/app/explores/routes.py`, `backend/app/main.py`
- Create: `backend/app/library/routes.py`
- Test: `backend/tests/test_library_routes.py`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces: `GET /api/reports?q=&favorite=&role=&sort=`, same for `/api/explores`; each summary gains `"favorite": bool` and `"lastViewedAt": str | None`. `POST /api/library/{item_type}/{item_id}/favorite` body `{"favorite": bool}`; `POST /api/library/{item_type}/{item_id}/view`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_library_routes.py
"""Finding your work, over HTTP -- and never anyone else's."""

from tests.test_report_routes import sign_in, valid_definition


def make_report(client, name):
    definition = valid_definition()
    definition["name"] = name
    return client.post("/api/reports", json={"definition": definition}).json()["id"]


class TestSearch:
    def test_search_matches_the_name(self, client, db):
        sign_in(client, db)
        db.commit()
        make_report(client, "Quarterly pipeline")
        make_report(client, "Churn by segment")
        found = client.get("/api/reports", params={"q": "churn"}).json()["reports"]
        assert [r["name"] for r in found] == ["Churn by segment"]

    def test_search_is_case_insensitive(self, client, db):
        sign_in(client, db)
        db.commit()
        make_report(client, "Quarterly pipeline")
        found = client.get("/api/reports", params={"q": "QUARTERLY"}).json()["reports"]
        assert len(found) == 1


class TestFavorites:
    def test_pinning_shows_on_the_summary_and_filters(self, client, db):
        sign_in(client, db)
        db.commit()
        keep = make_report(client, "Keep me")
        make_report(client, "Ignore me")

        assert client.post(
            f"/api/library/report/{keep}/favorite", json={"favorite": True}
        ).status_code == 200

        listed = client.get("/api/reports").json()["reports"]
        assert {r["name"]: r["favorite"] for r in listed} == {
            "Keep me": True, "Ignore me": False,
        }
        only = client.get("/api/reports", params={"favorite": True}).json()["reports"]
        assert [r["name"] for r in only] == ["Keep me"]

    def test_a_non_member_cannot_pin_or_even_learn_it_exists(self, client, db):
        sign_in(client, db, user="ALICE")
        db.commit()
        report_id = make_report(client, "Alice's")
        client.cookies.clear()
        sign_in(client, db, user="BOB")
        db.commit()
        r = client.post(
            f"/api/library/report/{report_id}/favorite", json={"favorite": True}
        )
        assert r.status_code == 404


class TestRecents:
    def test_viewing_records_and_sorts_first(self, client, db):
        sign_in(client, db)
        db.commit()
        first = make_report(client, "First")
        second = make_report(client, "Second")
        client.post(f"/api/library/report/{first}/view")

        listed = client.get("/api/reports", params={"sort": "recent"}).json()["reports"]
        assert listed[0]["name"] == "First"
        assert listed[0]["lastViewedAt"] is not None
        assert second in [r["id"] for r in listed]


class TestDeletionCleansUp:
    def test_state_does_not_outlive_the_item(self, client, db):
        from app.db.models import UserItemState

        sign_in(client, db)
        db.commit()
        report_id = make_report(client, "Doomed")
        client.post(f"/api/library/report/{report_id}/favorite", json={"favorite": True})
        client.delete(f"/api/reports/{report_id}")
        assert db.query(UserItemState).count() == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/test_library_routes.py -q`
Expected: FAIL — 404 on `/api/library/...`

- [ ] **Step 3: Add the library router**

```python
# backend/app/library/routes.py
"""Pinning an item and recording that it was opened.

Both go through the same authorization gate the item's own endpoints
use, so a stranger cannot pin -- or learn the existence of -- something
they may not read.
"""

import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.db.base import get_db
from app.db.models import DbSession, Report, SavedExplore
from app.errors import ApiError
from app.library import state
from app.workspaces.access import require_owned

router = APIRouter()

_MODELS = {"report": Report, "explore": SavedExplore}


class FavoriteBody(BaseModel):
    favorite: bool


def _authorized(db: Session, user_id, item_type: str, item_id: str):
    model = _MODELS.get(item_type)
    if model is None:
        raise ApiError("HTTP_ERROR", 404, "Unknown item type")
    # The item's own gate: a non-member gets 404, never a hint.
    return require_owned(db, user_id, model, item_id, need="viewer")


@router.post("/api/library/{item_type}/{item_id}/favorite")
def set_favorite(
    item_type: str,
    item_id: str,
    body: FavoriteBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    item = _authorized(db, sess.user_id, item_type, item_id)
    state.set_favorite(db, sess.user_id, item_type, item.id, body.favorite)
    return {"favorite": body.favorite}


@router.post("/api/library/{item_type}/{item_id}/view")
def record_view(
    item_type: str,
    item_id: str,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    item = _authorized(db, sess.user_id, item_type, item_id)
    state.record_view(db, sess.user_id, item_type, item.id)
    return {"ok": True}
```

Register it in `app/main.py` beside the other routers.

- [ ] **Step 4: Thread the filters through both services**

In `app/reports/service.py`, extend `list_reports` and stamp on write:

```python
def list_reports(
    db: Session,
    user_id: uuid.UUID,
    workspace_id: str | None = None,
    params: LibraryQuery | None = None,
) -> list[Report]:
    params = params or LibraryQuery()
    query = (
        select(Report)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Report.workspace_id)
        .where(WorkspaceMember.user_id == user_id)
    )
    if workspace_id:
        workspace = require_workspace(db, user_id, workspace_id, need="viewer")
        query = query.where(Report.workspace_id == workspace.id)
    # Narrowing only, and only after the membership join above.
    query = search.apply(query, Report, params)
    items = list(db.scalars(query))
    favorites = state.favorite_ids(db, user_id, "report")
    recents = state.recent_order(db, user_id, "report")
    items = search.filtered_ids(favorites, params, items)
    return search.order_items(items, params, recents, favorites)
```

Mirror it exactly in `app/explores/service.py` with `SavedExplore` and `"explore"`. In both `delete_*` service functions, call `state.forget_item(db, "<type>", item.id)` before deleting.

- [ ] **Step 5: Pass the query params in both routers**

```python
@router.get("/api/reports")
def list_reports(
    workspace: str | None = None,
    q: str | None = None,
    favorite: bool = False,
    role: str | None = None,
    sort: str = "recent",
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    params = LibraryQuery(q=q, favorite=favorite, role=role, sort=sort)
    reports = service.list_reports(db, sess.user_id, workspace, params)
    favorites = state.favorite_ids(db, sess.user_id, "report")
    recents = state.recent_order(db, sess.user_id, "report")
    out = []
    for report in reports:
        workspace_row, member_role = _context(db, sess.user_id, report)
        summary = _summary(report, workspace=workspace_row, role=member_role)
        summary["favorite"] = report.id in favorites
        seen = recents.get(report.id)
        summary["lastViewedAt"] = seen.isoformat() if seen else None
        out.append(summary)
    return {"reports": out}
```

Mirror in `app/explores/routes.py`.

- [ ] **Step 6: Run tests and lint**

Run: `.venv/Scripts/python.exe -m pytest -q && .venv/Scripts/python.exe -m ruff check app tests`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add backend/app backend/tests/test_library_routes.py
git commit -m "feat(library): search, favourites and recents on both lists"
```

---

### Task 5: Session execution context

**Files:**
- Create: `backend/app/session/__init__.py`, `backend/app/session/context.py`, `backend/app/session/routes.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_session_context.py`

**Interfaces:**
- Consumes: `get_cache().acquire`, `gateway.run_query`.
- Produces:
  - `available_roles(conn) -> list[str]`
  - `available_warehouses(conn) -> list[str]`
  - `apply_context(conn, role: str | None, warehouse: str | None) -> None`
  - `GET /api/session/context` → `{"role", "warehouse", "roles": [...], "warehouses": [...]}`
  - `POST /api/session/context` body `{"role": str|None, "warehouse": str|None}`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_session_context.py
"""Switching role and warehouse: validated, applied, remembered."""

from app.db.models import User
from app.snowflake.provider import get_cache
from tests.fakes import FakeConnection, FakeCursor
from tests.test_report_routes import sign_in


class ContextCursor(FakeCursor):
    """Answers SHOW GRANTS / SHOW WAREHOUSES, records USE statements."""

    def execute(self, sql, params=None):
        self.executed.append(sql)
        self.bound.append(params)
        upper = sql.upper()
        if upper.startswith("SHOW GRANTS TO USER"):
            self.description = [type("C", (), {"name": "role", "type_code": 2})()]
            self.rows = [("ANALYST",), ("FINANCE",)]
        elif upper.startswith("SHOW WAREHOUSES"):
            self.description = [type("C", (), {"name": "name", "type_code": 2})()]
            self.rows = [("COMPUTE_WH",), ("BIG_WH",)]
        else:
            self.rows = []
        return self


def login_with_context(client, db):
    sess = sign_in(client, db)
    conn = FakeConnection(ContextCursor())
    get_cache().put(sess.id, conn)
    db.commit()
    return sess, conn


class TestReadingContext:
    def test_it_lists_what_the_user_may_use(self, client, db):
        login_with_context(client, db)
        body = client.get("/api/session/context").json()
        assert body["roles"] == ["ANALYST", "FINANCE"]
        assert body["warehouses"] == ["COMPUTE_WH", "BIG_WH"]


class TestSwitching:
    def test_a_valid_switch_is_applied_and_remembered(self, client, db):
        sess, conn = login_with_context(client, db)
        r = client.post(
            "/api/session/context", json={"role": "FINANCE", "warehouse": "BIG_WH"}
        )
        assert r.status_code == 200
        statements = " ".join(conn.cursor().executed).upper()
        assert "USE ROLE" in statements and "USE WAREHOUSE" in statements
        user = db.get(User, sess.user_id)
        db.refresh(user)
        assert user.last_role == "FINANCE"
        assert user.last_warehouse == "BIG_WH"

    def test_a_role_the_user_lacks_is_refused_before_the_connection(self, client, db):
        _, conn = login_with_context(client, db)
        before = len(conn.cursor().executed)
        r = client.post("/api/session/context", json={"role": "ACCOUNTADMIN"})
        assert r.status_code == 400
        after = [s for s in conn.cursor().executed[before:] if s.upper().startswith("USE ")]
        assert after == []

    def test_an_identifier_with_a_quote_is_refused(self, client, db):
        login_with_context(client, db)
        r = client.post("/api/session/context", json={"role": 'X" OR 1=1--'})
        assert r.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/test_session_context.py -q`
Expected: FAIL — 404 on `/api/session/context`

- [ ] **Step 3: Implement the context module**

```python
# backend/app/session/context.py
"""The role and warehouse a session runs as.

Applied with USE ROLE / USE WAREHOUSE on the session's existing
connection rather than by reconnecting: it is instant and needs no
fresh token. Two consequences, both accepted and documented in the
spec -- the change is visible to anything sharing this session's
connection (an open workbook on its connect token, ADR 0003), and
switching to a role the token does not authorise needs
EXTERNAL_OAUTH_ANY_ROLE_MODE = ENABLE on the security integration.

Role and warehouse are IDENTIFIERS, so they cannot be bound as
parameters. They are validated against what Snowflake itself reports
the user may use, and quoted -- never interpolated raw.
"""

from typing import Any

from app.errors import ApiError
from app.semantic.discovery import quote_ident
from app.snowflake import gateway


def _names(conn: Any, sql: str, column: int) -> list[str]:
    result = gateway.run_query(conn, sql, max_rows=1000)
    return [str(row[column]) for row in result.rows if row[column]]


def available_roles(conn: Any) -> list[str]:
    """Roles granted to the current user, in Snowflake's own order."""
    seen, out = set(), []
    for name in _names(conn, "SHOW GRANTS TO USER CURRENT_USER()", 0):
        if name.upper() not in seen:
            seen.add(name.upper())
            out.append(name)
    return out


def available_warehouses(conn: Any) -> list[str]:
    """Warehouses the CURRENT ROLE may use -- SHOW already filters."""
    return _names(conn, "SHOW WAREHOUSES", 0)


def apply_context(conn: Any, role: str | None, warehouse: str | None) -> None:
    cur = conn.cursor()
    try:
        if role:
            cur.execute(f"USE ROLE {quote_ident(role)}")
        if warehouse:
            cur.execute(f"USE WAREHOUSE {quote_ident(warehouse)}")
    finally:
        cur.close()


def validate(choice: str | None, allowed: list[str], kind: str) -> str | None:
    """Refuse anything Snowflake did not just say the user may use."""
    if choice is None:
        return None
    match = next((a for a in allowed if a.upper() == choice.upper()), None)
    if match is None:
        raise ApiError("VALIDATION_ERROR", 400, f"{kind} is not available to you")
    return match
```

- [ ] **Step 4: Implement the routes**

```python
# backend/app/session/routes.py
"""Read and change the session's execution context."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.routes import current_session
from app.db.base import get_db
from app.db.models import DbSession, User
from app.session import context
from app.snowflake.provider import get_cache

router = APIRouter()


class ContextBody(BaseModel):
    role: str | None = None
    warehouse: str | None = None


def _entry(db: Session, sess: DbSession):
    return get_cache().acquire(db, sess)


@router.get("/api/session/context")
def read_context(
    sess: DbSession = Depends(current_session), db: Session = Depends(get_db)
) -> dict:
    entry = _entry(db, sess)
    with entry.lock:
        roles = context.available_roles(entry.conn)
        warehouses = context.available_warehouses(entry.conn)
    user = db.get(User, sess.user_id)
    return {
        "role": user.last_role,
        "warehouse": user.last_warehouse,
        "roles": roles,
        "warehouses": warehouses,
    }


@router.post("/api/session/context")
def set_context(
    body: ContextBody,
    sess: DbSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    entry = _entry(db, sess)
    with entry.lock:
        role = context.validate(body.role, context.available_roles(entry.conn), "Role")
        warehouse = context.validate(
            body.warehouse, context.available_warehouses(entry.conn), "Warehouse"
        )
        context.apply_context(entry.conn, role, warehouse)
    user = db.get(User, sess.user_id)
    if role:
        user.last_role = role
    if warehouse:
        user.last_warehouse = warehouse
    db.commit()

    from app.audit import record

    # Shapes only: which role, never what was queried with it.
    record(db, "session.context", user_id=sess.user_id, session_id=sess.id,
           detail={"role": role, "warehouse": warehouse})
    return {"role": user.last_role, "warehouse": user.last_warehouse}
```

Register in `app/main.py`.

- [ ] **Step 5: Run tests and lint**

Run: `.venv/Scripts/python.exe -m pytest -q && .venv/Scripts/python.exe -m ruff check app tests`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add backend/app/session backend/app/main.py backend/tests/test_session_context.py
git commit -m "feat(session): switch role and warehouse, validated and remembered"
```

---

### Task 6: Account picker and remembered context at login

**Files:**
- Modify: `backend/app/config.py`, `backend/app/auth/oauth.py`, `backend/app/auth/routes.py`
- Test: `backend/tests/test_login_accounts.py`

**Interfaces:**
- Consumes: Task 5's `context.apply_context`.
- Produces: `Settings.snowflake_accounts: list[AccountChoice]` where `AccountChoice` has `label: str` and `account: str`; `Settings.account_choices() -> list[AccountChoice]`; `/api/config` gains `"accounts": [{"label","account"}]`; `/auth/login?account=<id>`; `oauth.make_state(account: str | None = None)` and `consume_state(state) -> tuple[str | None, str | None]` returning `(verifier, account)`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_login_accounts.py
"""Choosing an account at login -- from the allow-list, and only it."""

import json
from urllib.parse import parse_qs, urlparse

from app.auth import oauth as oauth_mod
from app.auth.oauth import OAUTH_STATE_COOKIE, TokenResponse
from app.snowflake import connect as sf_connect
from tests.fakes import FakeConnection
from tests.test_auth_routes import OAUTH_ENV

ACCOUNTS = json.dumps([
    {"label": "Production", "account": "myorg-prod"},
    {"label": "Sandbox", "account": "myorg-dev"},
])


def test_config_lists_the_accounts(make_client):
    client = make_client(**OAUTH_ENV, SEMANTICUI_SNOWFLAKE_ACCOUNTS=ACCOUNTS)
    body = client.get("/api/config").json()
    assert [a["label"] for a in body["accounts"]] == ["Production", "Sandbox"]


def test_a_single_account_still_works_without_the_new_setting(make_client):
    client = make_client(**OAUTH_ENV)
    body = client.get("/api/config").json()
    assert [a["account"] for a in body["accounts"]] == ["myorg-myaccount"]


def test_an_account_outside_the_list_is_refused(make_client):
    client = make_client(**OAUTH_ENV, SEMANTICUI_SNOWFLAKE_ACCOUNTS=ACCOUNTS)
    r = client.get(
        "/auth/login", params={"account": "attacker-host"}, follow_redirects=False
    )
    assert r.status_code == 400


def test_the_chosen_account_reaches_the_connection(make_client, db, monkeypatch):
    client = make_client(**OAUTH_ENV, SEMANTICUI_SNOWFLAKE_ACCOUNTS=ACCOUNTS)
    seen = {}

    class StubOAuth:
        def exchange_code(self, code, code_verifier=None):
            return TokenResponse("at-1", "rt-1", 600)

    def fake_connect(token, user=None, role=None, account=None):
        seen["account"] = account
        return FakeConnection()

    monkeypatch.setattr(oauth_mod, "get_oauth_client", lambda: StubOAuth())
    monkeypatch.setattr(sf_connect, "connect_oauth", fake_connect)
    monkeypatch.setattr(sf_connect, "probe_identity", lambda c: ("ACME", "ALICE"))

    started = client.get(
        "/auth/login", params={"account": "myorg-dev"}, follow_redirects=False
    )
    state = parse_qs(urlparse(started.headers["location"]).query)["state"][0]
    client.cookies.set(OAUTH_STATE_COOKIE, state)
    r = client.get(
        "/auth/callback", params={"code": "c", "state": state}, follow_redirects=False
    )
    assert r.status_code == 303
    assert seen["account"] == "myorg-dev"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/test_login_accounts.py -q`
Expected: FAIL — `KeyError: 'accounts'`

- [ ] **Step 3: Add the setting**

```python
# backend/app/config.py — above class Settings
class AccountChoice(BaseModel):
    """One entry in the login dropdown."""

    label: str
    account: str


# inside class Settings
    #: Accounts offered at login. Absent, the single snowflake_account
    #: below is the only choice, so existing deployments are unaffected.
    snowflake_accounts: list[AccountChoice] = []

# as a method on Settings
    def account_choices(self) -> list[AccountChoice]:
        if self.snowflake_accounts:
            return self.snowflake_accounts
        if self.snowflake_account:
            return [AccountChoice(label=self.snowflake_account,
                                  account=self.snowflake_account)]
        return []

    def allows_account(self, account: str | None) -> bool:
        """Never trust a submitted account: pointing our credentials at
        an arbitrary host is exactly what an allow-list prevents."""
        if account is None:
            return True
        return any(c.account == account for c in self.account_choices())
```

Import `BaseModel` from pydantic at the top of `config.py`.

- [ ] **Step 4: Bind the account into the OAuth state**

```python
# backend/app/auth/oauth.py
#: state -> (created, PKCE verifier, chosen account). The account rides
#: the state rather than a query parameter on the callback so it cannot
#: be swapped between the redirect and the return.
_states: dict[str, tuple[float, str, str | None]] = {}


def make_state(account: str | None = None) -> str:
    _prune_expired_states()
    state = secrets.token_urlsafe(16)
    verifier = secrets.token_urlsafe(48)
    _states[state] = (time.monotonic(), verifier, account)
    _enforce_state_cap()
    return state


def consume_state(state: str) -> tuple[str | None, str | None]:
    """Single use: (verifier, account) while live, (None, None) after."""
    entry = _states.pop(state, None)
    if entry is None:
        return None, None
    created, verifier, account = entry
    if (time.monotonic() - created) >= _STATE_TTL_SECONDS:
        return None, None
    return verifier, account
```

Update `challenge_for` to read `entry[1]`. Update every existing caller and test stub of `consume_state` to the tuple return.

- [ ] **Step 5: Use it in the auth routes**

In `oauth_login`, accept `account: str | None = None`, reject with 400 when `not get_settings().allows_account(account)`, and pass it to `make_state`. In `oauth_callback`, unpack `verifier, account = oauth_mod.consume_state(state)`, pass `account=account` to `connect_oauth`, and after a successful connection apply the remembered context:

```python
    user = db.get(User, sess.user_id)
    if user.last_role or user.last_warehouse:
        from app.session import context
        try:
            context.apply_context(conn, user.last_role, user.last_warehouse)
        except Exception:
            # A remembered role that has since been revoked must not
            # cost the user their login -- fall back to the session
            # defaults and let them pick again.
            logger.info("remembered context no longer usable; using defaults")
```

Add `accounts` to `/api/config`. Add an `account` parameter to `sf_connect.connect_oauth` that overrides `settings.snowflake_account` when given.

- [ ] **Step 6: Run tests and lint**

Run: `.venv/Scripts/python.exe -m pytest -q && .venv/Scripts/python.exe -m ruff check app tests`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add backend/app backend/tests/test_login_accounts.py
git commit -m "feat(auth): choose the Snowflake account at login; replay remembered context"
```

---

### Task 7: Frontend API clients

**Files:**
- Create: `frontend/src/api/library.ts`, `frontend/src/api/session.ts`
- Test: `frontend/src/api/library.test.ts`

**Interfaces:**
- Produces: `LibraryParams {q?, favorite?, role?, sort?}`; `libraryQueryString(params): string`; `setFavorite(itemType, id, favorite)`; `recordView(itemType, id)`; `getSessionContext()`; `setSessionContext({role?, warehouse?})`.

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/api/library.test.ts
import { describe, expect, it } from "vitest";
import { libraryQueryString } from "./library";

describe("libraryQueryString", () => {
  it("omits everything at its default", () => {
    expect(libraryQueryString({})).toBe("");
  });

  it("includes only what was set", () => {
    expect(libraryQueryString({ q: "churn", sort: "name" })).toBe(
      "?q=churn&sort=name",
    );
  });

  it("encodes values that need it", () => {
    expect(libraryQueryString({ q: "a b&c" })).toBe("?q=a+b%26c");
  });

  it("sends favorite only when true", () => {
    expect(libraryQueryString({ favorite: false })).toBe("");
    expect(libraryQueryString({ favorite: true })).toBe("?favorite=true");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/api/library.test.ts`
Expected: FAIL — cannot resolve `./library`

- [ ] **Step 3: Implement**

```typescript
// frontend/src/api/library.ts
import { apiFetch } from "./client";

export type ItemType = "report" | "explore";
export type LibrarySort = "recent" | "name" | "updated";

export interface LibraryParams {
  q?: string;
  favorite?: boolean;
  role?: string;
  sort?: LibrarySort;
}

/** Only non-default values travel, so the URL stays readable and the
 *  query cache key stays stable. */
export function libraryQueryString(params: LibraryParams): string {
  const search = new URLSearchParams();
  if (params.q?.trim()) search.set("q", params.q.trim());
  if (params.favorite) search.set("favorite", "true");
  if (params.role) search.set("role", params.role);
  if (params.sort && params.sort !== "recent") search.set("sort", params.sort);
  const query = search.toString();
  return query ? `?${query}` : "";
}

export function setFavorite(itemType: ItemType, id: string, favorite: boolean) {
  return apiFetch<{ favorite: boolean }>(
    `/api/library/${itemType}/${id}/favorite`,
    { method: "POST", body: JSON.stringify({ favorite }) },
  );
}

export function recordView(itemType: ItemType, id: string) {
  return apiFetch<{ ok: boolean }>(`/api/library/${itemType}/${id}/view`, {
    method: "POST",
  });
}
```

```typescript
// frontend/src/api/session.ts
import { apiFetch } from "./client";

export interface SessionContext {
  role: string | null;
  warehouse: string | null;
  roles: string[];
  warehouses: string[];
}

export function getSessionContext() {
  return apiFetch<SessionContext>("/api/session/context");
}

export function setSessionContext(next: {
  role?: string | null;
  warehouse?: string | null;
}) {
  return apiFetch<{ role: string | null; warehouse: string | null }>(
    "/api/session/context",
    { method: "POST", body: JSON.stringify(next) },
  );
}
```

- [ ] **Step 4: Run tests and types**

Run: `npm test -- --run src/api/library.test.ts && npx tsc --noEmit`
Expected: 4 passed, tsc clean

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/library.ts frontend/src/api/session.ts frontend/src/api/library.test.ts
git commit -m "feat(api): library and session-context clients"
```

---

### Task 8: Browse components

**Files:**
- Create: `frontend/src/library/useLibraryQuery.ts`, `frontend/src/library/SearchBar.tsx`, `frontend/src/library/FacetChips.tsx`, `frontend/src/library/FavoriteStar.tsx`
- Test: `frontend/src/library/SearchBar.test.tsx`, `frontend/src/library/FacetChips.test.tsx`

**Interfaces:**
- Consumes: Task 7.
- Produces: `useLibraryQuery()` returning `{params, setSearch, setSort, toggleFavoriteFilter, setRole, clearAll, activeFacets}`; `<SearchBar value onChange placeholder />`; `<FacetChips facets onClear shown total />`; `<FavoriteStar itemType id favorite />`.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/library/FacetChips.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FacetChips } from "./FacetChips";

describe("FacetChips", () => {
  it("says why the list is shorter than the whole", () => {
    render(<FacetChips facets={[{ key: "role", label: "Role: ANALYST" }]}
      onClear={() => {}} shown={12} total={137} />);
    expect(screen.getByText(/showing 12 of 137/i)).toBeInTheDocument();
  });

  it("clears a facet when its chip is dismissed", async () => {
    const onClear = vi.fn();
    render(<FacetChips facets={[{ key: "role", label: "Role: ANALYST" }]}
      onClear={onClear} shown={12} total={137} />);
    await userEvent.click(screen.getByRole("button", { name: /clear role/i }));
    expect(onClear).toHaveBeenCalledWith("role");
  });

  it("stays out of the way when nothing is filtered", () => {
    const { container } = render(
      <FacetChips facets={[]} onClear={() => {}} shown={137} total={137} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

```tsx
// frontend/src/library/SearchBar.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchBar } from "./SearchBar";

describe("SearchBar", () => {
  it("reports what was typed", async () => {
    const onChange = vi.fn();
    render(<SearchBar value="" onChange={onChange} />);
    await userEvent.type(screen.getByRole("searchbox"), "ch");
    expect(onChange).toHaveBeenCalled();
  });

  it("offers a way to clear once there is something to clear", async () => {
    const onChange = vi.fn();
    render(<SearchBar value="churn" onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /clear search/i }));
    expect(onChange).toHaveBeenCalledWith("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run src/library`
Expected: FAIL — cannot resolve modules

- [ ] **Step 3: Implement the components**

```tsx
// frontend/src/library/FacetChips.tsx
export interface Facet {
  key: string;
  label: string;
}

/** Why the list is shorter than the whole, and how to undo it.
 *  A filter the reader cannot see is indistinguishable from missing
 *  data -- which is the whole reason this is a chip and not a mode. */
export function FacetChips({
  facets,
  onClear,
  shown,
  total,
}: {
  facets: Facet[];
  onClear: (key: string) => void;
  shown: number;
  total: number;
}) {
  if (facets.length === 0) return null;
  return (
    <div className="facets">
      <span className="facets-count">
        Showing {shown} of {total}
      </span>
      {facets.map((facet) => (
        <button
          key={facet.key}
          type="button"
          className="chip"
          aria-label={`Clear ${facet.key}`}
          onClick={() => onClear(facet.key)}
        >
          {facet.label} <span aria-hidden="true">✕</span>
        </button>
      ))}
    </div>
  );
}
```

```tsx
// frontend/src/library/SearchBar.tsx
export function SearchBar({
  value,
  onChange,
  placeholder = "Search by name, view or workspace",
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="searchbar">
      <input
        type="search"
        className="searchbar-input"
        value={value}
        placeholder={placeholder}
        aria-label="Search"
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button
          type="button"
          className="searchbar-clear"
          aria-label="Clear search"
          onClick={() => onChange("")}
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}
```

```tsx
// frontend/src/library/FavoriteStar.tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { setFavorite, type ItemType } from "../api/library";

export function FavoriteStar({
  itemType,
  id,
  favorite,
  invalidate,
}: {
  itemType: ItemType;
  id: string;
  favorite: boolean;
  invalidate: string;
}) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => setFavorite(itemType, id, !favorite),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [invalidate] }),
  });
  return (
    <button
      type="button"
      className={favorite ? "star star-on" : "star"}
      aria-label={favorite ? "Unpin" : "Pin"}
      aria-pressed={favorite}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        toggle.mutate();
      }}
    >
      {favorite ? "★" : "☆"}
    </button>
  );
}
```

```typescript
// frontend/src/library/useLibraryQuery.ts
import { useMemo, useState } from "react";
import type { LibraryParams, LibrarySort } from "../api/library";
import type { Facet } from "./FacetChips";

/** The browse state for one list: what is typed, what is filtered, how
 *  it is sorted. Kept out of the page components so reports and
 *  explores cannot drift into behaving differently. */
export function useLibraryQuery(initialRole?: string) {
  const [params, setParams] = useState<LibraryParams>({
    sort: "recent",
    role: initialRole,
  });

  const activeFacets = useMemo<Facet[]>(() => {
    const facets: Facet[] = [];
    if (params.role) facets.push({ key: "role", label: `Role: ${params.role}` });
    if (params.favorite) facets.push({ key: "favorite", label: "Pinned only" });
    if (params.q?.trim()) facets.push({ key: "q", label: `“${params.q.trim()}”` });
    return facets;
  }, [params]);

  return {
    params,
    activeFacets,
    setSearch: (q: string) => setParams((p) => ({ ...p, q })),
    setSort: (sort: LibrarySort) => setParams((p) => ({ ...p, sort })),
    setRole: (role?: string) => setParams((p) => ({ ...p, role })),
    toggleFavoriteFilter: () =>
      setParams((p) => ({ ...p, favorite: !p.favorite })),
    clearFacet: (key: string) =>
      setParams((p) => ({
        ...p,
        role: key === "role" ? undefined : p.role,
        favorite: key === "favorite" ? false : p.favorite,
        q: key === "q" ? "" : p.q,
      })),
  };
}
```

- [ ] **Step 4: Run tests, types, lint**

Run: `npm test -- --run src/library && npx tsc --noEmit && npm run lint`
Expected: 5 passed, clean

- [ ] **Step 5: Commit**

```bash
git add frontend/src/library
git commit -m "feat(library): search bar, facet chips and pin control"
```

---

### Task 9: Wire browsing into the two lists

**Files:**
- Modify: `frontend/src/reports/ReportListPage.tsx`, `frontend/src/explorer/ExplorerPage.tsx`, `frontend/src/api/reports.ts`, `frontend/src/api/explores.ts`
- Test: `frontend/src/reports/ReportListPage.test.tsx` (extend)

**Interfaces:**
- Consumes: Tasks 7 and 8. `listReports(workspaceId?, params?)` and `listExplores(workspaceId?, params?)` gain the params argument, appended via `libraryQueryString`.

- [ ] **Step 1: Write the failing test**

```tsx
// added to frontend/src/reports/ReportListPage.test.tsx
it("filters the list as you search", async () => {
  renderList([
    { id: "1", name: "Quarterly pipeline", favorite: false },
    { id: "2", name: "Churn by segment", favorite: false },
  ]);
  await userEvent.type(screen.getByRole("searchbox"), "churn");
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("q=churn"), expect.anything(),
    ),
  );
});

it("shows a pin control on every row", async () => {
  renderList([{ id: "1", name: "Quarterly pipeline", favorite: true }]);
  expect(await screen.findByRole("button", { name: /unpin/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/reports/ReportListPage.test.tsx`
Expected: FAIL — no searchbox

- [ ] **Step 3: Implement**

Add the params argument to both API functions:

```typescript
export function listReports(workspaceId?: string, params: LibraryParams = {}) {
  const query = libraryQueryString(params);
  const scope = workspaceId
    ? `${query ? `${query}&` : "?"}workspace=${encodeURIComponent(workspaceId)}`
    : query;
  return apiFetch<{ reports: ReportSummary[] }>(`/api/reports${scope}`);
}
```

In `ReportListPage.tsx`, call `useLibraryQuery()`, pass `params` into the query key and `listReports`, and render `<SearchBar>`, `<FacetChips>` and a `<FavoriteStar>` per row. Call `recordView("report", id)` when a row is opened. Mirror the same three elements in the explores list region of `ExplorerPage.tsx`.

- [ ] **Step 4: Run the full frontend gate**

Run: `npm test -- --run && npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(library): search, pins and facets on the report and explore lists"
```

---

### Task 10: Profile menu with role and warehouse

**Files:**
- Create: `frontend/src/session/useSessionContext.ts`, `frontend/src/session/ProfileMenu.tsx`, `frontend/src/session/ProfileMenu.test.tsx`
- Modify: `frontend/src/shell/AppShell.tsx`

**Interfaces:**
- Consumes: Task 7's `getSessionContext`/`setSessionContext`.
- Produces: `useSessionContext()` returning `{context, isLoading, switchTo}`; `<ProfileMenu />` replacing the identity text in the top bar.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/session/ProfileMenu.test.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProfileMenu } from "./ProfileMenu";

vi.mock("../api/session", () => ({
  getSessionContext: vi.fn().mockResolvedValue({
    role: "ANALYST", warehouse: "COMPUTE_WH",
    roles: ["ANALYST", "FINANCE"], warehouses: ["COMPUTE_WH", "BIG_WH"],
  }),
  setSessionContext: vi.fn().mockResolvedValue({
    role: "FINANCE", warehouse: "COMPUTE_WH",
  }),
}));

function renderMenu() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProfileMenu user="ALICE" account="ACME" />
    </QueryClientProvider>,
  );
}

describe("ProfileMenu", () => {
  it("shows the current role and warehouse without opening", async () => {
    renderMenu();
    expect(await screen.findByText(/ANALYST/)).toBeInTheDocument();
    expect(await screen.findByText(/COMPUTE_WH/)).toBeInTheDocument();
  });

  it("switches role from the menu", async () => {
    const { setSessionContext } = await import("../api/session");
    renderMenu();
    await userEvent.click(await screen.findByRole("button", { name: /account menu/i }));
    await userEvent.selectOptions(
      await screen.findByLabelText(/role/i), "FINANCE",
    );
    expect(setSessionContext).toHaveBeenCalledWith({ role: "FINANCE" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/session`
Expected: FAIL — cannot resolve `./ProfileMenu`

- [ ] **Step 3: Implement**

```typescript
// frontend/src/session/useSessionContext.ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSessionContext, setSessionContext } from "../api/session";

/** The role and warehouse this session runs as. Changing either
 *  re-runs every query, because the same report can legitimately
 *  return different rows under a different role. */
export function useSessionContext() {
  const queryClient = useQueryClient();
  const context = useQuery({
    queryKey: ["session-context"],
    queryFn: getSessionContext,
  });
  const switchTo = useMutation({
    mutationFn: setSessionContext,
    onSuccess: () => queryClient.invalidateQueries(),
  });
  return { context: context.data, isLoading: context.isLoading, switchTo };
}
```

```tsx
// frontend/src/session/ProfileMenu.tsx
import { useState } from "react";
import { useSessionContext } from "./useSessionContext";

export function ProfileMenu({ user, account }: { user: string; account: string }) {
  const [open, setOpen] = useState(false);
  const { context, switchTo } = useSessionContext();

  return (
    <div className="profile">
      <button
        type="button"
        className="profile-trigger"
        aria-label="Account menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="profile-identity">{user} @ {account}</span>
        <span className="profile-context">
          {context?.role ?? "—"} · {context?.warehouse ?? "—"}
        </span>
      </button>
      {open && context ? (
        <div className="profile-menu" role="menu">
          <label className="profile-field">
            Role
            <select
              value={context.role ?? ""}
              onChange={(e) => switchTo.mutate({ role: e.target.value })}
            >
              {context.roles.map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
          </label>
          <label className="profile-field">
            Warehouse
            <select
              value={context.warehouse ?? ""}
              onChange={(e) => switchTo.mutate({ warehouse: e.target.value })}
            >
              {context.warehouses.map((warehouse) => (
                <option key={warehouse} value={warehouse}>{warehouse}</option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
    </div>
  );
}
```

Replace the identity span in `AppShell.tsx` (around line 57) with `<ProfileMenu user={me.data.snowflakeUser} account={me.data.snowflakeAccount} />`, keeping the existing logout button.

- [ ] **Step 4: Run the full frontend gate**

Run: `npm test -- --run && npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add frontend/src/session frontend/src/shell/AppShell.tsx
git commit -m "feat(session): role and warehouse switcher in the profile menu"
```

---

### Task 11: Account picker on the login page

**Files:**
- Create: `frontend/src/auth/AccountPicker.tsx`, `frontend/src/auth/AccountPicker.test.tsx`
- Modify: `frontend/src/auth/LoginPage.tsx`

**Interfaces:**
- Consumes: `/api/config` `accounts` from Task 6.
- Produces: `<AccountPicker accounts value onChange />`; the sign-in link becomes `/auth/login?account=<chosen>`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/auth/AccountPicker.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccountPicker } from "./AccountPicker";

const ACCOUNTS = [
  { label: "Production", account: "myorg-prod" },
  { label: "Sandbox", account: "myorg-dev" },
];

describe("AccountPicker", () => {
  it("lists every configured account by its label", () => {
    render(<AccountPicker accounts={ACCOUNTS} value="myorg-prod" onChange={() => {}} />);
    expect(screen.getByRole("option", { name: "Production" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Sandbox" })).toBeInTheDocument();
  });

  it("reports the chosen account", async () => {
    const onChange = vi.fn();
    render(<AccountPicker accounts={ACCOUNTS} value="myorg-prod" onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText(/account/i), "myorg-dev");
    expect(onChange).toHaveBeenCalledWith("myorg-dev");
  });

  it("stays hidden when there is only one account to pick", () => {
    const { container } = render(
      <AccountPicker accounts={[ACCOUNTS[0]]} value="myorg-prod" onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/auth/AccountPicker.test.tsx`
Expected: FAIL — cannot resolve `./AccountPicker`

- [ ] **Step 3: Implement**

```tsx
// frontend/src/auth/AccountPicker.tsx
export interface AccountChoice {
  label: string;
  account: string;
}

/** Hidden when there is nothing to choose: a dropdown with one entry
 *  is a decision the user does not have. */
export function AccountPicker({
  accounts,
  value,
  onChange,
}: {
  accounts: AccountChoice[];
  value: string;
  onChange: (account: string) => void;
}) {
  if (accounts.length < 2) return null;
  return (
    <label className="login-field">
      Account
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {accounts.map((choice) => (
          <option key={choice.account} value={choice.account}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  );
}
```

In `LoginPage.tsx`, read `accounts` from the existing `/api/config` query, hold the choice in state defaulting to the first entry, render `<AccountPicker>` above the sign-in button, and point the button at `/auth/login?account=${encodeURIComponent(chosen)}`.

- [ ] **Step 4: Run the full frontend gate**

Run: `npm test -- --run && npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add frontend/src/auth
git commit -m "feat(auth): pick the Snowflake account on the login page"
```

---

### Task 12: Documentation

**Files:**
- Modify: `backend/.env.example`, `docs/architecture/low-level.md`, `docs/CONTRIBUTING.md`
- Create: `docs/architecture/decisions/0009-role-is-a-facet-not-a-boundary.md`

- [ ] **Step 1: Write the ADR**

```markdown
# 0009 — A Snowflake role is a facet, not a boundary

Status: Accepted

## Context

Power users hold many roles and accumulate hundreds of saved items.
The first proposal scoped workspaces to roles and hid the rest.

## Decision

Membership remains the only rule for both access and visibility. Role
is recorded on saved items as provenance and offered as a visible,
clearable filter chip alongside search, recents and favourites.

## Consequences

- One mental model: if you are a member you can see it, always.
- A filter can never be mistaken for a boundary, because the chip
  states what is being hidden and one click removes it.
- Role-based ACLs stay available as a future decision (see 0003) and
  would supersede this if regulated separation is ever required.
- Free-form labels can replace or join the role facet without a
  migration, since a facet is only a filter chip.
```

- [ ] **Step 2: Update the other docs**

Add `SEMANTICUI_SNOWFLAKE_ACCOUNTS` to `.env.example` with the JSON shape and a note that it is optional. Add `library` and `session` to the package table in `low-level.md`. Add the ADR to `docs/architecture/decisions/README.md`.

- [ ] **Step 3: Commit**

```bash
git add docs backend/.env.example
git commit -m "docs: ADR 0009 and the settings for accounts and library"
```

---

## Self-Review

**Spec coverage.** Account picker → Tasks 6, 11. Role/warehouse switcher → Tasks 5, 10. Remembered context → Tasks 1, 5, 6. Search → Tasks 3, 4, 8, 9. Recents → Tasks 2, 4, 9. Favourites → Tasks 2, 4, 8, 9. Role facet → Tasks 1, 3, 8. Module boundaries → the file structure table. Testing → each task's own steps.

**Type consistency.** `LibraryQuery` is the backend name throughout; `LibraryParams` is the frontend name — deliberately different because one is a pydantic model and the other a TS interface, and they are converted by `libraryQueryString`. `ITEM_TYPES`/`ItemType` agree on `"report" | "explore"`. `consume_state` returns a tuple in every caller after Task 6, which is a breaking change to existing tests — Task 6 Step 4 calls this out explicitly.

**Sequencing risk.** Tasks 1–4 deliver finding with no auth change. Tasks 5–6 touch the login path, which is live; both keep the single-account and no-remembered-context paths working, asserted by tests in Task 6.
