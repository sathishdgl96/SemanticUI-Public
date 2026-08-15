# Filters, Hierarchies & Drill-Down — Design

**Date:** 2026-08-15
**Status:** Approved pending final review
**Sub-project:** 2b of the 5-part roadmap

## Roadmap Context

Sub-project 1 shipped per-user Snowflake authentication, a per-user connection
cache, a query gateway that builds all SQL server-side, and the explorer.
Sub-project 2a shipped the report canvas: a `reports` table holding JSON
definitions, seven visual types, owner-scoped CRUD, deterministic export and
untrusted-input import, and a per-session DESCRIBE cache.

2b adds the analytical depth that makes those reports answer questions rather
than only display them: **filters**, **hierarchies with drill-down**, and
**cross-filtering** between visuals.

Sub-projects 3 (workspaces & sharing), 4 (Cortex Q&A) and 5 (Excel export)
follow unchanged.

## Decisions Taken

| Decision | Choice | Why |
|---|---|---|
| Scope | All three together | Filters are the primitive; drill-down is a filter plus an axis swap, cross-filtering is a transient filter from a selection. Splitting would build the same foundation twice. |
| Hierarchy source | Model-first, report-defined fallback | Report-defined works against any semantic view today; a detector activates the model path if the account exposes one. |
| Cross-filter default | Filters other visuals automatically | The behaviour a report canvas is expected to have; useful with no configuration. |
| Operators | `is` / `isNot`, `between`, `relativeDate` | Covers most real filters, and each maps to one bound-parameter predicate. Top-N deferred — it is a windowed subquery, a different shape. |
| Drill behaviour | Replace the level | PowerBI's default and the model most users already hold. |
| Drill position | Ephemeral | A saved report opens at the top level; keeps the document clean. |

## Prerequisite Spike — Task 1 of the plan

**Everything here depends on one unverified assumption: that Snowflake's
`SEMANTIC_VIEW(...)` accepts a `WHERE` clause and that bind parameters work
inside it.**

Filters must be pushed *inside* the semantic-view query, not applied to its
output. A KPI card showing total revenue filtered to one region has no
`REGION` column in its result to filter on — the predicate has to apply before
aggregation or the feature is impossible for exactly the visuals that need it
most.

The plan's first task is therefore a spike against the real account
(`SEMANTICUI_IT_*` credentials) that establishes:

1. The exact accepted syntax and clause order for a filtered
   `SEMANTIC_VIEW(...)` query.
2. Whether bind parameters are accepted inside that clause, and in which
   paramstyle.
3. Whether a filter may reference a dimension that is *not* among the query's
   `DIMENSIONS` — the KPI case above.

**If any answer differs from the assumption, the spike stops and reports;
the design changes before implementation.** Two fallbacks exist and are ranked:
push the predicate through a derived table that still precedes aggregation, or
require that any filtered dimension also appear in `DIMENSIONS` and filter the
result — the second is a real functional reduction and would need your sign-off.

## The Central Security Property

Every SQL statement this product has built so far uses only *identifiers*,
each validated against a live `DESCRIBE SEMANTIC VIEW` on the requesting
user's own connection and quoted by `quote_ident`. **Filters are the first
feature where user-supplied values reach a query.**

The rules, which no part of the implementation may relax:

1. **Values are bound parameters, never SQL text.** The builder returns SQL
   plus an ordered parameter list; `run_query` binds them. No filter value is
   ever concatenated, interpolated, quoted-and-embedded, or f-stringed into a
   statement.
2. **Field references keep the existing path** — resolved against the describe
   catalog, emitted as `quote_ident` output, never taken from user text.
3. **Operators come from a closed enum.** An unrecognised operator is a
   `REPORT_INVALID` rejection, not a passthrough.
4. **Relative dates are resolved server-side** into bound timestamps. No date
   arithmetic is assembled from user input as text.
5. **Value counts and lengths are bounded** so a filter cannot become a
   denial-of-service vector: at most 500 values per filter, each at most 255
   characters.
6. **Cross-filter selections are subject to every rule above.** They are
   filters that happen to originate from a click rather than a form.

A test asserts that a filter value containing SQL metacharacters
(`' OR 1=1 --`) round-trips as data and appears nowhere in the generated SQL
text.

## Filter Model

Filters live in the definition document at two scopes. Report-scope filters sit
at the top level and apply to every visual; visual-scope filters sit on the
visual they belong to. They compose by intersection — a visual's effective
filter set is report filters AND its own AND any active cross-filter.

```json
{
  "schemaVersion": 2,
  "filters": [
    { "id": "f1", "field": "CUSTOMERS.REGION", "op": "is",
      "values": ["EAST", "WEST"] }
  ],
  "visuals": [
    { "id": "v1", "type": "bar",
      "filters": [
        { "id": "f2", "field": "ORDERS.ORDER_DATE", "op": "relativeDate",
          "unit": "day", "count": 30 }
      ]
    }
  ]
}
```

Operator shapes:

| `op` | Fields | Predicate |
|---|---|---|
| `is` | `values: string[]` (1-500) | `field IN (?, ?, …)`; a single value emits `=` |
| `isNot` | `values: string[]` (1-500) | `field NOT IN (?, ?, …)` |
| `between` | `from`, `to` (both numbers, or both ISO dates) | `field BETWEEN ? AND ?` |
| `relativeDate` | `unit: day\|month\|year`, `count: int`, or `preset: monthToDate\|yearToDate` | resolved server-side to `field BETWEEN ? AND ?` |

`between` requires `from <= to` and both endpoints of the same kind. A filter
whose field is absent from the describe catalog is rejected with
`REPORT_INVALID` naming the reference — the same rule imports already follow.

## Hierarchies and Drill-Down

A hierarchy is an ordered list of dimension references stored in the report:

```json
"hierarchies": [
  { "id": "h1", "name": "Geography",
    "levels": ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY"] }
]
```

A visual's Axis well may hold a hierarchy reference (`"hierarchy:h1"`) in place
of a plain field. The visual renders the level it is currently on; clicking a
mark drills — the clicked value becomes a filter and the axis advances one
level. A breadcrumb shows the path and an up control walks back. Reaching the
last level disables further drilling.

Every level must be a dimension present in the bound view, checked at
validation time, and a hierarchy must have at least two levels — a one-level
hierarchy is a plain field.

**Drill position is ephemeral.** It lives in component state alongside the
cross-filter selection, so a saved report always opens at the top level. This
keeps the document free of view state and avoids a stored drill path pointing
at a value that no longer exists.

**Model-first detection** ships as a function over the describe result that
returns any hierarchy-shaped objects it finds and an empty list otherwise.
Today's parser sees only tables, relationships, dimensions, metrics and facts,
so the report-defined path is what works from day one; the detector activates
automatically if the account exposes hierarchies. An integration test records
what the real account actually returns, which is how the question gets settled
with evidence rather than assumption.

## Cross-Filtering

Clicking a mark in one visual filters every other visual on the canvas to that
value; clicking the same mark again clears it. The selection is **transient**:
it lives in React state, is never written to the definition, and is gone on
reload.

It composes with saved filters by intersection and is subject to the same
validation and binding rules. A visual never cross-filters itself. When a
selection is active the canvas shows a clearly labelled "Filtered by …" chip
with a clear control, so the state is never invisible.

## Schema Migration

The definition schema currently requires `schemaVersion == 1` exactly and
declares `extra="forbid"`. Adding filters and hierarchies makes every stored
document v1 and every new one v2, and neither build could read the other's.

2b therefore adds `migrate_definition(raw: dict) -> dict`, called *before*
pydantic validation, which upgrades a v1 document by adding empty `filters` and
`hierarchies` collections and setting `schemaVersion` to 2. `SCHEMA_VERSION`
becomes 2; v1 remains readable forever through the migration; anything above
the current version is still rejected.

This is deliberately done now, while there is one prior version and almost no
stored data. Retrofitting an upgrade path after several versions exist is
materially harder.

## Query Path

`POST /api/query/semantic` gains an optional `filters` array — the effective,
already-composed set for that visual. The request stays a description of
*what to select*, never SQL.

`build_semantic_sql` returns `(sql, params)` instead of `sql`. `run_query`
gains a `params` argument and passes it to the cursor. The gateway's row cap,
statement timeout and error mapping are unchanged.

`useVisualQuery`'s cache key becomes
`["visual-query", view, type, wells, filters, drillPath, crossFilter]`.
Without this a filtered tile would serve the unfiltered result it cached
moments earlier — the single most likely bug in this phase.

Distinct-value lists for the filter editor come from a new
`GET /api/semantic-views/{db}/{schema}/{name}/values?field=…` endpoint, which
runs a capped `SELECT DISTINCT` on the caller's own connection through the same
gateway, with the field validated against the describe catalog exactly as
everywhere else. Results are capped at 1,000 values with a "showing first N"
signal.

## UI

- **Filters pane** joins the builder's right-hand stack beneath Fields, showing
  report filters and — when a visual is selected — that visual's own, with a
  clear indication of which scope each belongs to.
- **Adding a filter**: drag a field onto the pane or click a field's filter
  affordance. The editor offers only the operators valid for that field's type.
- **Drill** is a click on a mark plus a breadcrumb and an up control in the
  tile header. Keyboard equivalents are required: the tile is focusable, Enter
  drills into the focused mark, Backspace drills up.
- **Cross-filter state** appears as a labelled chip above the canvas with a
  clear control.
- Every existing constraint carries over: drag is never the only path, focus
  outlines are never removed, hit targets clear 24px, chrome is never painted
  in a series colour, and the layout holds at 1440 / 1280 / 1024 / 768 / 390px.

## Error Handling

Errors stay per visual. A filter referencing a field the viewer's role cannot
see fails that tile with `SNOWFLAKE_FORBIDDEN` while its neighbours keep their
data. An invalid filter definition is rejected at save or import time with
`REPORT_INVALID` naming the offending filter id and field. A drill into a level
whose dimension has disappeared from the view reports that on the tile and
offers to drill back up rather than blanking the canvas.

## Testing

- **Spike (task 1):** the syntax questions above, answered against the real
  account and written into the plan before anything else is built.
- **Backend unit:** predicate construction per operator; parameter ordering;
  relative-date resolution at known clock values; value-count and length caps;
  rejection of unknown operators and unknown field references; the SQL-injection
  round-trip test; `migrate_definition` upgrading a v1 document and leaving a v2
  document untouched; hierarchy level validation.
- **Backend API:** a filtered query passes bound parameters to the cursor;
  the distinct-values endpoint validates its field and caps results; filters on
  a dimension absent from `DIMENSIONS` behave as the spike established.
- **Frontend:** the query key changes when any filter, drill level or
  cross-filter selection changes; filter editor offers only type-valid
  operators; drill advances and retreats correctly and stops at the last level;
  cross-filter applies to siblings but never to the originating visual;
  keyboard drill works.
- **Integration:** a filtered query and a two-level drill against a real
  semantic view, plus the hierarchy-detection probe that records what the
  account exposes.

## Out of Scope

Top-N and text-search filters; filter interactions configured per visual pair;
report pages/tabs (page-scope filters are report-scope while a report is one
page); persisted drill state; sync/async slicer visuals as first-class tiles;
the matrix visual. Workspaces and sharing remain sub-project 3, Cortex Q&A 4,
Excel export 5.
