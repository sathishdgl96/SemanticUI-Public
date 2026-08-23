# Session context and finding your work — design

Date: 2026-08-20
Status: approved in conversation, ready for planning

## The problem

A power user holding ten Snowflake roles accumulates a hundred-odd
explores and reports, and the app gives them one undifferentiated list
to find anything in. Everything a user saves without naming a workspace
lands in their personal workspace (`_target()` falls back to
`personal_workspace_id`), so the pile has no structure to browse by.

The first instinct was to scope workspaces to Snowflake roles and hide
the rest. That was rejected during design, on three grounds:

* It creates a second permission system. Access would be membership,
  visibility would be role, and "I am a member, why can't I see it?"
  becomes the common complaint — answered by a mode not visible from the
  list being looked at.
* It hides without protecting. Access stays membership, so a member in
  the "wrong" role can still open the item by URL. A filter dressed as a
  boundary is worse than either.
* Roles are the wrong shape. A role answers "what data may I read"; a
  workspace answers "where does this work live". A Finance workspace may
  legitimately be read by FINANCE and AUDITOR both, and people hold
  several roles at once, so "current role" is a mode rather than an
  identity.

## The approach

Treat this as a **browsing** problem. Membership remains the only rule
for both access and visibility, so there is exactly one mental model.
Finding is served by search, recents and favourites, with role as a
**visible, clearable facet** rather than a silent mode.

The distinction that makes this safe: a facet says "showing 12 of 137,
Role: ANALYST ✕". A mode just shows 12. The first is organisation; the
second is the confusion described above.

Separately, and independently useful: the session gains an explicit
**execution context** — Snowflake account (chosen at login), role and
warehouse (switchable in the profile menu, remembered across logins).

## Scope

In scope:

1. Account picker at login, from a configured allow-list.
2. Role and warehouse switcher in the profile menu; both remembered.
3. Search across reports and explores.
4. Recents — no user effort required.
5. Favourites — explicit pinning.
6. Role/warehouse provenance stamp on saved items, surfaced as a facet.

Out of scope, deliberately: role-based access control, per-role personal
workspaces, workspace-level role tagging, free-form labels. Labels slot
into the same facet UI later without another migration if role turns out
not to be the axis people group by.

## Data model — migration 0007

```
users
  + last_role        String(255) NULL   -- remembered execution context
  + last_warehouse   String(255) NULL

reports, saved_explores
  + snowflake_role       String(255) NULL   -- provenance: what it was
  + snowflake_warehouse  String(255) NULL   -- created/last saved under

user_item_state                        -- one row per (user, item)
    user_id     FK users     NOT NULL
    item_type   String(16)   NOT NULL  -- 'report' | 'explore'
    item_id     Uuid         NOT NULL
    favorite    Boolean      NOT NULL DEFAULT false
    last_viewed_at DateTime  NULL
    UNIQUE (user_id, item_type, item_id)
    INDEX (user_id, last_viewed_at)
    INDEX (user_id, favorite)
```

One table serves recents and favourites because they are one concern:
this user's relationship to this item. Every column is nullable or
defaulted, so the migration cannot hide or alter existing data.

`item_type` is a string rather than two nullable foreign keys: reports
and explores are separate tables, and a polymorphic reference keeps the
table from growing a column per item kind. Rows are cleaned up when the
item is deleted, in the same service call that deletes it.

## Configuration

```
SEMANTICUI_SNOWFLAKE_ACCOUNTS=[{"label":"Production","account":"myorg-prod"},
                               {"label":"Sandbox","account":"myorg-dev"}]
```

Absent, it falls back to a single entry built from today's
`SNOWFLAKE_ACCOUNT`, so existing deployments are unaffected and the
setting stays optional.

`/api/config` exposes the list (labels and identifiers, nothing secret)
for the login dropdown.

## Request flows

**Login with an account.** The login page renders the dropdown and calls
`/auth/login?account=<identifier>`. The account is validated against the
configured list — never free-form, or the endpoint becomes a way to aim
our credentials at an arbitrary Snowflake host — and bound into the
OAuth state entry beside the PKCE verifier, so the callback knows which
account to connect to without trusting a round-trip parameter.

**Applying remembered context.** After the connection opens, the
callback applies `users.last_role` and `users.last_warehouse` when they
are still usable, falling back to the token's role and the user's
default warehouse when they are not. A remembered role that has been
revoked must degrade to a working session, never a failed login.

**Switching.** `GET /api/session/roles` and `GET /api/session/warehouses`
read from `SHOW GRANTS TO USER` and `SHOW WAREHOUSES` on the caller's own
connection. `POST /api/session/context` validates the choice against
those lists, issues `USE ROLE` / `USE WAREHOUSE` on the cached
connection, persists to `users.last_*`, and records an audit event.

Applying rather than reconnecting is deliberate: it is instant and needs
no fresh token. Two consequences are accepted and documented — the
switch affects anything sharing the session's connection (an open Excel
workbook via its connect token, per ADR 0003), and switching to a role
the token does not authorise requires
`EXTERNAL_OAUTH_ANY_ROLE_MODE = ENABLE` on the security integration.
With `DISABLE`, the switcher offers only the token's role.

**Finding.** List endpoints for reports and explores accept `q` (search),
`favorite`, `role`, and `sort` (recent | name | updated). Search matches
name, semantic view and workspace name. Filtering happens in SQL, after
the existing membership join — the facet narrows what a user may already
see and never widens it.

## Module boundaries

New backend modules, each with one job:

* `app/session/context.py` — read and apply role/warehouse on a
  connection; the only place `USE ROLE` is issued.
* `app/session/routes.py` — the three endpoints above.
* `app/library/state.py` — favourites and recents (`user_item_state`).
* `app/library/search.py` — the query filter applied by both list
  endpoints, so reports and explores cannot drift apart.

Frontend, following the split already applied to `reports/builder/`:

* `src/session/useSessionContext.ts` — current account/role/warehouse,
  the lists, the switch mutation.
* `src/session/ProfileMenu.tsx` — the switcher UI.
* `src/auth/AccountPicker.tsx` — the login dropdown.
* `src/library/` — `SearchBar.tsx`, `FacetChips.tsx`, `FavoriteStar.tsx`,
  `useLibraryQuery.ts`, shared by the reports and explores lists so the
  two browse experiences stay identical.

## Testing

Migration: an upgrade over a database holding existing reports and
explores leaves every row readable and visible.

Auth: an account outside the allow-list is refused; the chosen account
reaches the connection; a revoked remembered role degrades to a working
session rather than a failed login.

Context: `USE ROLE` is issued once and persisted; an invalid role or
warehouse is refused before it touches the connection; the audit trail
records the switch without recording data.

Library: search matches on each of the three fields; favourites and
recents are per user and never leak across users; deleting an item
removes its state rows; a facet can only narrow the membership-scoped
set, asserted by a test that a non-member sees nothing whatever the
filter says.

## Sequencing

Value lands before schema risk:

1. Search and recents — most of the pain, no new permissions surface.
2. Favourites.
3. Role/warehouse stamp and the facet chip.
4. Profile switcher and account picker.
