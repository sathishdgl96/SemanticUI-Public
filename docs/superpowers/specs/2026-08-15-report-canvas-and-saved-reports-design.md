# Report Canvas & Saved Reports — Design

**Date:** 2026-08-15
**Status:** Approved pending final review
**Sub-project:** 2a of the 5-part roadmap

## Roadmap Context

Sub-project 1 (Foundation) shipped: per-user Snowflake authentication (OAuth,
external browser, password, key-pair), a per-user connection cache, a query
gateway that builds all SQL server-side, and a single-visual semantic view
explorer with Axis/Legend/Values wells.

Sub-project 2 was originally scoped as "report authoring & saved reports"
covering a chart catalog, a multi-visual canvas, saved reports, filters, and
hierarchies with drill-down. That is too much for one spec, so it is split:

- **2a — this spec.** Report canvas, visual catalog, save/load, export/import.
  Closes the gap between an *explore* surface and a *report builder*.
- **2b — later.** Filters (visual and page scope), hierarchies, drill-down,
  cross-filtering between visuals.

Sub-projects 3 (workspaces & sharing), 4 (Cortex Q&A) and 5 (Excel export)
follow unchanged.

## Goal

A signed-in user can build a report containing several visuals over one
semantic view, arrange them on a grid canvas, choose each visual's type from a
catalog, save the report, reopen it later, and move it between deployments by
copying its JSON definition.

Every query still executes on a connection authenticated as the requesting
user. The app stores report *definitions* only — never query results.

## Decisions Taken

| Decision | Choice | Why |
|---|---|---|
| Scope | Canvas + catalog + save/load first | Delivers the PowerBI shape; filters and drill-down layer on afterwards |
| View binding | One semantic view per report | Mirrors report-bound-to-dataset; keeps the field list unambiguous and makes 2b's cross-filtering well-defined |
| Layout | 12-column snap grid, drag + resize | PowerBI feel, tidy layouts, stores as `{x,y,w,h}` |
| Catalog | Core seven | Covers most real tiles; matrix and exotic visuals wait for evidence they are needed |
| Explorer | Kept alongside the builder | Fast ad-hoc exploration survives, with "Add to report" as the on-ramp |
| Execution | Independent per-visual queries + per-session describe cache | Progressive rendering without N describes per refresh |
| Storage | JSON `definition` document | A report is a document that keeps growing; 2b lands without a migration per option |

## Architecture

```
Browser (React SPA)
  /reports            report list
  /reports/:id        builder — canvas + Visualizations pane + Fields pane
  /explore            existing ad-hoc explorer (unchanged behaviour)
        │
        ▼
FastAPI  ── /api/reports/*   definition CRUD, export, import  ── PostgreSQL
        └─ /api/query/semantic  (one call per visual, unchanged contract)
                │
                ▼
        ConnectionProvider → per-user connection cache → Snowflake
                                  └─ per-entry DESCRIBE cache (new)
```

Nothing about the security model changes: `current_session` → the caller's own
cache entry → their own Snowflake connection. Report rows add an ownership
layer *on top of* Snowflake RBAC; they never substitute for it.

## Data Model

New `reports` table. Real columns for what is queried or sorted on; the
document for everything else.

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| owner_user_id | uuid FK → users.id | the durable identity anchor from sub-project 1 |
| name | text | shown in the list; also carried in the export |
| view_database | text | bound semantic view |
| view_schema | text | |
| view_name | text | |
| definition | JSON | the document below (JSONB on Postgres, JSON on SQLite) |
| created_at | timestamptz | |
| updated_at | timestamptz | |

Index on `owner_user_id`. Alembic migration `0002`.

`definition` is the same document that export produces and import consumes:

```json
{
  "schemaVersion": 1,
  "name": "Sales overview",
  "view": { "database": "ANALYTICS", "schema": "PUBLIC", "name": "SALES" },
  "canvas": { "columns": 12, "rowHeight": 40 },
  "visuals": [
    {
      "id": "v1",
      "type": "bar",
      "title": "Revenue by region",
      "layout": { "x": 0, "y": 0, "w": 6, "h": 6 },
      "wells": {
        "axis": ["CUSTOMERS.REGION"],
        "legend": [],
        "values": ["ORDERS.TOTAL_REVENUE"]
      },
      "options": { "stacked": false }
    }
  ]
}
```

`view` is duplicated between columns and document deliberately: the columns
serve listing and filtering, the document must stay self-contained so an
export is portable on its own.

## Visual Catalog

**Wells are declared per visual type**, generalising sub-project 1's fixed
Axis/Legend/Values triple. A visual type declares each well's name, the field
kind it accepts, and its cardinality. This is what lets scatter take two
metrics on its axes without distorting the model for every other type.

| Type | Wells (kind, cardinality) | Query mapping |
|---|---|---|
| `bar` | Axis (dimension, 1) · Legend (dimension, 0-1) · Values (metric, 1+) | dimensions = axis + legend; metrics = values |
| `line` | same as bar | same |
| `area` | same as bar | same |
| `pie` | Legend (dimension, 1) · Values (metric, exactly 1) | dimensions = legend; metrics = values |
| `scatter` | X (metric, 1) · Y (metric, 1) · Detail (dimension, 0-1) | dimensions = detail; metrics = [x, y] |
| `table` | Dimensions (dimension, 0+) · Metrics (metric, 0+), at least one field overall | passed through |
| `kpi` | Value (metric, exactly 1) | dimensions = []; metrics = value |

Two rules carry over from sub-project 1 and apply to every type. A field
reference may appear in only one well of a visual — placing the same field in
two wells produces a duplicated projection and a degenerate result, so it is
refused. And `table` must hold at least one field overall, since the query
gateway rejects a request naming neither a dimension nor a metric.

Each visual's `id` is unique within its report; import rejects a document with
duplicate ids rather than silently renaming.

Options per type: `bar`/`area` carry `stacked` (boolean); `pie` carries
`donut` (boolean); `kpi` carries `format` (`number` | `compact`); others have
none in 2a.

A visual whose wells are incomplete renders a "needs fields" placeholder
rather than issuing a query. Legend combined with several Values remains
ambiguous, so the existing rule stands: the first metric charts, and the
visual says so.

Rendering reuses the validated colourblind-safe palette in
`src/query/palette.ts` unchanged — series colour continues to follow the
metric's (or legend value's) stable index, never its rank.

## Execution & the DESCRIBE Cache

Each visual issues its own `POST /api/query/semantic`, so tiles render as they
complete and one slow visual cannot block the page. The endpoint's contract is
unchanged.

That endpoint runs `DESCRIBE SEMANTIC VIEW` before every query to validate
field references against what the caller's role can see. With N visuals that
is N identical describes per refresh. Fix: cache the describe result **inside
the caller's own `CacheEntry`**, keyed by fully-qualified view name, guarded by
that entry's existing lock.

- The cache is per-session by construction — it lives in the same object that
  holds the user's connection, so it cannot be read by another session and
  dies when their session does. It is never a process-global map.
- Entries expire after a new setting `describe_cache_ttl_seconds` (default 300)
  so semantic model changes are picked up without a restart.
- A "Refresh fields" action in the builder clears the cache for the bound view.

## API

All routes require an authenticated session and are scoped to the caller's own
`users` row. A report belonging to another user is indistinguishable from one
that does not exist (404, not 403) so the endpoints do not confirm existence to
non-owners.

| Endpoint | Behaviour |
|---|---|
| `GET /api/reports` | list the caller's reports: id, name, view, updated_at |
| `POST /api/reports` | create from `{name, view, definition}` |
| `GET /api/reports/{id}` | full row + definition |
| `PUT /api/reports/{id}` | replace name / view / definition |
| `DELETE /api/reports/{id}` | delete |
| `GET /api/reports/{id}/export` | the portable document (see below) |
| `POST /api/reports/import` | `{definition, viewOverride?}` → creates a new report |

Errors use the existing envelope. New code `REPORT_INVALID` (400) covers a
definition that fails validation; `HTTP_ERROR` 404 covers not-found.

## Export & Import

**Export** returns the definition document and nothing else — no owner, no
timestamps, no report id, no query results, no credentials. It is serialised
with sorted keys and stable indentation so two exports of an unchanged report
are byte-identical and the file diffs cleanly in version control.

**Import accepts untrusted input and is written accordingly.** A pasted
document is treated exactly like any other external input:

- Request body capped (64 KB) and visual count capped (50 per report).
- Parsed against a strict pydantic schema; unknown fields rejected rather than
  ignored, so a typo'd key is a visible error instead of silent data loss.
- `schemaVersion` must be one this build understands; anything else is
  rejected with a message naming the supported version.
- Every visual's `type` must be in the catalog, and its wells must satisfy that
  type's declared kinds and cardinalities.
- **Every field reference is re-validated against a live `DESCRIBE` on the
  importing user's own connection.** A reference to a field that no longer
  exists, or that the importer's role cannot see, is reported — never
  silently dropped and never passed through to SQL construction.
- Nothing in the document can alter how SQL is built. Identifiers still come
  from the describe-derived catalog; the document only selects among them.

**Portability.** Field refs (`ORDERS.TOTAL_REVENUE`) are internal to the
semantic model and stable across deployments. The view reference
(`ANALYTICS.PUBLIC.SALES`) is not — dev and prod commonly differ. So import
accepts an optional `viewOverride`, and when the named view is not found the
UI asks which view to bind to rather than failing outright.

Import always creates a **new** report owned by the importer; it never
overwrites an existing one. Report names are not unique, so importing the same
document twice yields two independent reports rather than an error — the user
renames if they want to tell them apart.

## Builder UI

PowerBI-shaped, and a departure from the explorer's left-to-right flow:

```
┌─ Sales overview            [Save] [Export] [Import] ─┐
│ ┌───────────────────────────┐ ┌────────────────────┐ │
│ │                           │ │ VISUALIZATIONS     │ │
│ │      canvas               │ │ ▣ ▤ ▥ ◕ ⁘ ▦ 12    │ │
│ │  (12-col snap grid,       │ ├────────────────────┤ │
│ │   drag + resize)          │ │ Axis   ⬦ dimension │ │
│ │                           │ │ Legend ⬦ dimension │ │
│ │                           │ │ Values Σ metric    │ │
│ │                           │ ├────────────────────┤ │
│ │                           │ │ FIELDS             │ │
│ │                           │ │ ⬦ ORDERS.DATE      │ │
│ │                           │ │ Σ ORDERS.REVENUE   │ │
│ └───────────────────────────┘ └────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

- Canvas dominates; the Visualizations pane (type picker, then the selected
  visual's wells) sits above the Fields pane on the right.
- Selecting a visual populates the wells; changing its type re-renders in
  place, keeping any wells the new type can still accept and reporting which
  were dropped.
- Drag and resize snap to the 12-column grid. `react-grid-layout` provides
  this; it is maintained and supports a controlled layout we persist directly.
- Explicit Save. Export opens a copyable JSON panel; Import a paste box.
- Report list at `/reports` becomes the landing route; `/` redirects there.
  The explorer moves to `/explore` and gains "Add to report".

The dense-analytical visual language, the two type roles (system sans for
interface, monospace for identifiers), the responsive breakpoints, the 24px
hit-target floor, visible focus rings and reduced-motion support all carry over
unchanged. Below 960px the builder stacks like the explorer: canvas first,
panes beneath; drag-to-arrange is a desktop affordance, and on small screens
visuals render in layout order without repositioning.

## Error Handling

Errors are per visual, not per page. A visual whose query fails shows the
message inside its own tile while its neighbours keep their data — one broken
tile must not blank the report. Codes reuse the existing envelope:
`SNOWFLAKE_FORBIDDEN` (the viewer's role cannot see a field), `QUERY_ERROR`,
`TIMEOUT`, and `AUTH_EXPIRED` (which still routes to login, now carrying its
reason).

Opening a report whose bound view has since disappeared shows a report-level
message offering to rebind to another view — the same mechanism import uses.

## Testing

- **Backend unit:** definition schema validation, every import rejection case
  (oversized, unknown field, bad version, unknown visual type, well
  cardinality violation, unknown field ref), well→query mapping per visual
  type, describe-cache hit/miss/TTL, and cross-session cache isolation.
- **Backend API:** owner scoping (another user's report is 404), export
  determinism (two calls byte-identical), import→open round trip, and
  import with `viewOverride`.
- **Frontend:** per-type well rules, layout persistence through save/reload,
  export panel contents, import paste flow including the rebind prompt,
  per-visual error isolation, and keyboard operation of the type picker and
  wells (drag remains never the only path).
- **Integration:** the existing env-gated suite gains a report round trip
  against a real semantic view.

## Security Properties

1. Every query runs on the requesting user's own Snowflake connection.
   Unchanged from sub-project 1 and not weakened here.
2. Reports store definitions only. No query results are ever persisted.
3. Report access is owner-scoped; non-owners get 404, not 403.
4. Imported definitions are untrusted: capped, strictly parsed, version-checked,
   and every field reference re-validated against the importer's own describe.
5. Exports carry no credentials, no identity, no timestamps, and no data.
6. The describe cache lives inside the per-session connection entry and can
   never serve one user's catalog to another.

## Size Note

This is a large sub-project — comparable to sub-project 1 — because a canvas
is not usable without visuals to place on it or a way to save what you built.
Expect an implementation plan in the fifteen-to-twenty task range, backend
first (migration, CRUD, export/import, describe cache), then the builder shell,
then the visual catalog, then export/import UI.

## Out of Scope (later sub-projects)

Filters, hierarchies, drill-down, cross-filtering, report pages/tabs, and the
matrix visual (all 2b). Workspaces, sharing and roles (3). Cortex Q&A (4).
Excel export (5). Also out of scope here: scheduled refresh, embedding,
report versioning/history, and templates.
