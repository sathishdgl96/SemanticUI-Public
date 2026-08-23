# Workspaces & Sharing — Design

**Date:** 2026-08-16
**Status:** Approved
**Sub-project:** 3 of the 5-part roadmap

## Roadmap Context

Sub-project 1 shipped per-user Snowflake authentication, a per-user connection
cache, and a query gateway that builds all SQL server-side. 2a shipped the
report canvas and portable definition documents. 2b shipped filters,
hierarchies, drill-down and cross-filtering.

Reports today belong to exactly one owner. `get_owned_report` returns 404 to
everyone else, so there is no way to show a colleague your work short of
exporting the JSON and having them import it.

3 adds **workspaces** as the unit of collaboration, and **membership** as the
only thing that grants access to someone else's report.

Sub-projects 4 (Cortex Q&A) and 5 (Excel export) follow unchanged.

## The Constraint This Sub-Project Exists To Preserve

From the original brief: *"it must allow workspace kind of setup along with
sharing, even with sharing, everything must use their own credential when
loading the report."*

**Sharing shares report definitions. It never shares data.**

This is already true by construction and must stay true. Every query runs on
`entry.conn`, the connection belonging to the *requesting* session, acquired
from that user's own Snowflake login. There is no service account, no stored
result set, and no cached data shared between users — the describe cache lives
inside each session's `CacheEntry`, never in a process-global.

So a viewer opening a shared report runs its queries as themselves. If their
Snowflake role cannot read the underlying view, the tiles fail with
`SNOWFLAKE_FORBIDDEN` and they see the report's *shape* and none of its
numbers. That is the correct and intended outcome, not a bug to work around.

This is stated as a property with a test rather than a claim: a two-user test
puts both users in one workspace, gives the second a connection that raises
insufficient-privileges, and asserts the definition is served while the data
is not.

## Decisions Taken

| Decision | Choice | Why |
|---|---|---|
| Unit of sharing | Workspaces only | One concept, one access-check path. "Why can this person see this?" has a single answer. Per-report shares can be added later without redesign. |
| Roles | Admin / Editor / Viewer | Admin manages membership, Editor changes report definitions, Viewer opens them. Data access remains entirely Snowflake's business. |
| Existing reports | Personal workspace per user | Everything lives in exactly one workspace, so there is no second access path to disagree with the first. |
| Adding members | By Snowflake username, same account only | You cannot require a colleague to log in before you may share with them. Cross-account membership would grant access to a definition their credentials could never resolve. |
| Non-member response | 404, not 403 | Matches the existing rule: a non-member must not learn that an id exists. |

## Data Model

Alembic revision `0003`, following `0002`.

### `workspaces`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | varchar(200) | |
| `kind` | varchar(16) | `personal` or `shared` |
| `snowflake_account` | varchar(255) | The account this workspace belongs to; membership is confined to it |
| `created_at` | timestamptz | |

`kind` is not cosmetic. A personal workspace refuses members and cannot be
renamed or deleted, which is what distinguishes "my drafts" from "a workspace
that happens to have one member today".

### `workspace_members`

| Column | Type | Notes |
|---|---|---|
| `workspace_id` | uuid FK → workspaces | |
| `user_id` | uuid FK → users | |
| `role` | varchar(16) | `admin`, `editor` or `viewer` |
| `created_at` | timestamptz | |

Unique on `(workspace_id, user_id)`. Indexed on `user_id`, because "which
workspaces am I in" is the hot query on every report list.

### `reports`

Gains `workspace_id` (uuid FK, indexed, NOT NULL).

`owner_user_id` **stays**, demoted to provenance: it records who created the
report, for display and for auditing. It is no longer consulted for access.
Keeping it costs nothing and losing it would discard information we cannot
reconstruct.

### The Migration

1. Create both tables.
2. Add `reports.workspace_id` as nullable.
3. For each distinct `owner_user_id` in `reports`: create a personal workspace
   named "My reports", add that user as `admin`, and set `workspace_id` on
   their reports.
4. Make `reports.workspace_id` NOT NULL.

Users who own no reports get their personal workspace lazily, on next login —
handled in `create_session` alongside the existing get-or-create of the user
row. Doing it there rather than in the migration means a user who has never
signed in does not get a workspace they may never use, and a user added as a
member before their first login still resolves correctly.

## Authorization

One function replaces `get_owned_report`:

```python
def require_access(db, user_id, report_id, *, need: Role) -> Report
```

It resolves report → workspace → membership and applies exactly two rules:

- **No membership at all → 404.** Identical to today's behaviour for a
  stranger's report id. A non-member must not be able to distinguish "does not
  exist" from "exists and is not yours".
- **Membership with too low a role → 403,** naming the role required. At this
  point the user already knows the report exists, so an honest error is more
  useful than a misleading 404.

Role ordering is `viewer < editor < admin`, expressed once as an ordered tuple
rather than scattered comparisons.

Route requirements:

| Route | Needs |
|---|---|
| `GET /api/reports/{id}` | viewer |
| `GET /api/reports/{id}/export` | viewer |
| `PUT /api/reports/{id}` | editor |
| `DELETE /api/reports/{id}` | editor |
| `POST /api/reports` | editor in the target workspace |
| `POST /api/reports/import` | editor in the target workspace |

`GET /api/reports` lists reports across every workspace the caller belongs to,
with an optional `?workspace=` filter.

## Workspace Endpoints

| Route | Purpose | Requires |
|---|---|---|
| `GET /api/workspaces` | Workspaces I belong to, with my role in each | session |
| `POST /api/workspaces` | Create a shared workspace; creator becomes admin | session |
| `PATCH /api/workspaces/{id}` | Rename | admin, and not personal |
| `DELETE /api/workspaces/{id}` | Delete, with its reports | admin, and not personal |
| `GET /api/workspaces/{id}/members` | List members | viewer |
| `POST /api/workspaces/{id}/members` | Add by Snowflake username | admin |
| `PATCH /api/workspaces/{id}/members/{user_id}` | Change role | admin |
| `DELETE /api/workspaces/{id}/members/{user_id}` | Remove | admin |
| `POST /api/reports/{id}/move` | Move to another workspace | editor on **both** |

## Guard Rails

Each is enforced server-side. Hiding a control in the UI is not enforcement.

1. **The last admin cannot be removed or demoted.** A workspace with no admin
   can never again have its membership changed — it is permanently stuck. The
   check covers demotion as well as removal, and covers a user removing
   themselves.
2. **Personal workspaces refuse members, renames and deletion.** That is what
   makes them personal.
3. **Membership is confined to one Snowflake account.** Adding a user from a
   different account is rejected: their credentials cannot resolve the
   workspace's views, so the grant would be an illusion of access.
4. **Moving a report requires editor on both ends.** Requiring it only on the
   destination would let anyone pull a report out of a workspace they can only
   read; requiring it only on the source would let them push it somewhere they
   cannot write.
5. **Deleting a workspace deletes its reports.** Cascade, stated explicitly,
   and the UI names the count before asking.

## Error Handling

Errors keep the existing `ApiError` shape and codes. New code:
`WORKSPACE_FORBIDDEN` (403) for a role that is insufficient, so the frontend
can distinguish "you cannot do this" from "this does not exist" and say so.

A viewer opening a report whose view their role cannot read is **not** an
authorization failure of ours — the report loads, and each tile independently
reports `SNOWFLAKE_FORBIDDEN`. The empty state says so in those terms rather
than implying the report is broken.

## Frontend

- **Workspace switcher** in the report list header, listing every workspace
  with the caller's role. Personal workspace first.
- **Members panel**, reachable from the switcher, visible to all members but
  editable only by admins. Add-by-username, role dropdown, remove. The last
  admin's controls are disabled with a stated reason rather than absent.
- **Workspace selector** when creating a report, defaulting to the current
  workspace.
- **Move report** in the builder, listing only workspaces where the caller is
  at least editor.
- Read-only affordances for viewers: Save, Import and well editing are
  disabled with a hint naming their role, not hidden.
- Every existing constraint carries over: drag is never the only path, focus
  outlines are never removed, hit targets clear 24px, chrome is never painted
  in a series colour, and the layout holds at 1440 / 1280 / 1024 / 768 / 390px.

## Testing

- **Migration:** a report owned by a user before `0003` ends up in that user's
  personal workspace with them as admin, and `workspace_id` is NOT NULL after.
- **Authorization matrix:** for each route, a member of each role and a
  non-member; asserting 404 for non-members and 403 for insufficient roles.
- **Guard rails:** last admin cannot be removed, demoted, or remove themselves;
  personal workspace refuses members; cross-account member rejected; move
  requires editor on both ends.
- **The credential property:** two users in one workspace, the second holding a
  connection that raises insufficient-privileges. The report definition is
  served to both; the data is served only to the first. This is the test that
  proves sharing shares definitions and not data.
- **No cross-user cache bleed:** user A's describe of a view must never be
  served to user B, even for the same report in the same workspace.
- **Frontend:** switcher lists only my workspaces; members panel hides
  mutations from non-admins; a viewer sees Save disabled with a reason; moving
  a report offers only workspaces I can write to.
- **Integration:** the two-user path against the real account, using two
  distinct Snowflake logins if available, skipping with a stated reason if not.

## Out of Scope

Per-report sharing outside a workspace; public or anonymous links, which would
violate the credential rule outright; cross-account sharing; nested workspaces;
workspace-level default filters; transferring ownership; audit logs. Cortex
Q&A remains sub-project 4 and Excel export 5.
