# Pages & Filter Scopes (sub-project 7a) — Design

**Date:** 2026-08-16
**Status:** Approved direction (user chose "all four sub-projects, 7a first")

## Context

The user's goal for sub-projects 7a–7d: report generation rich enough that
PowerBI-trained authors can sit down and use it without retraining. 7a is the
structural half: real pages and PowerBI's three filter scopes. Everything
later (slicers, format pane, data ops) hangs off this schema.

Roadmap decided with the user on 2026-08-16:

- **7a — Pages & filter scopes** (this spec)
- **7b — Visual richness**: slicer, matrix, card variants, stacked/clustered
  gallery tiles
- **7c — Format pane**: Build/Format toggle, per-visual formatting, text box
  and image visuals
- **7d — Data operations**: per-visual sort, Top N, visual header menu, and
  ad-hoc aggregation (approved: wrap the semantic query in an outer
  aggregate; semantic METRICS stay first-class)

## What 7a delivers

1. A report is a list of **pages**, each with its own name, visuals, and
   page-scope filters. The page bar under the canvas becomes real: switch,
   add, rename, duplicate, delete, and reorder pages.
2. **Three filter scopes**, exactly PowerBI's: *Filters on this visual*,
   *Filters on this page*, *Filters on all pages* — intersected in that
   order with drill and cross-filter, as today.
3. Definition **schema v3** with a v2→v3 migration, and — new — migration
   applied on the **read path**, because v3 is the first structurally
   breaking version.

Out of scope for 7a (deliberately): per-page canvas sizes, hidden pages,
drag-to-reorder tabs (Move left/right actions instead), page-level
tooltips/drill-through. YAGNI until a later sub-project needs them.

## Schema v3

```json
{
  "schemaVersion": 3,
  "name": "...",
  "view": { "database": "...", "schema": "...", "name": "..." },
  "canvas": { "columns": 12, "rowHeight": 40 },
  "filters": [],
  "hierarchies": [],
  "pages": [
    {
      "id": "p1",
      "name": "Page 1",
      "visuals": [ ... ],
      "filters": [ ... ]
    }
  ]
}
```

- Top-level `visuals` is **gone** (extra="forbid" rejects it; migration
  removes it).
- Top-level `filters` changes meaning: it is now the **all-pages** scope.
- `pages` is required, `min 1` (a report always has at least one page —
  PowerBI's rule too), `max 20` (`MAX_PAGES`).
- Page: `id` (1–64 chars), `name` (1–100 chars), `visuals`, `filters`.
- `hierarchies` and `canvas` stay report-level.

### Validation (parse_definition)

- `MAX_VISUALS = 50` now counts across **all pages combined**.
- Visual ids unique across the whole report (duplication mints new ids).
- Page ids unique; page **names** unique (case-sensitive) — duplicate tab
  labels help nobody, and PowerBI refuses them too.
- Unbound view allowed only when **no page** holds visuals.
- Filter-id uniqueness per scope: report, each page, each visual.
- Hierarchy well-reference checks iterate every page's visuals.

### Migration v2→v3

In `migrate.py`, chained after v1→v2 (a v1 document passes through both):

```python
if raw.get("schemaVersion") == 2 and "pages" not in raw:
    upgraded = {**raw, "schemaVersion": 3,
        "pages": [{"id": "p1", "name": "Page 1",
                   "visuals": raw.get("visuals", []),
                   "filters": raw.get("filters", [])}],
        "filters": []}
    upgraded.pop("visuals", None)
```

v2's top-level `filters` were labelled "Filters on this page" in the UI, so
they become the migrated page's filters; the new all-pages scope starts
empty. A claimed-v2 document that already carries `pages` is malformed and
passes through untouched for the validator to reject — the module's
"tolerant, let the validator name the problem" rule.

### Migration on read (new)

`GET /api/reports/{id}` (and the list/detail shapers) currently return
`report.definition` raw from the DB. v1→v2 survived that only because the
frontend papered over missing keys with `?? []`; `pages` replacing `visuals`
cannot be papered over. Fix: `_detail` in `routes.py` returns
`migrate_definition(report.definition)`. Migrate only — not full
`parse_definition` — so a stored document that later rules would reject
still loads rather than 404-ing its owner. The stored row upgrades to v3 on
its next save, as before.

### Other backend touch points

- `service.import_report` field-reference validation iterates report
  filters, then each page's filters, then each page's visuals (wells +
  visual filters).
- `to_export_document` needs no change — it serialises whatever the model
  holds.

## Frontend

### Types

```ts
export interface Page {
  id: string;
  name: string;
  visuals: Visual[];
  filters: Filter[];
}

export interface ReportDefinition {
  schemaVersion: number;
  name: string;
  view: ViewRef;
  canvas: CanvasSettings;
  pages: Page[];
  /** All-pages scope. */
  filters: Filter[];
  hierarchies: Hierarchy[];
}
```

`ReportListPage` mints new reports at v3 with one page (`p1` / "Page 1").
`ExplorerPage` keeps sending its v1 hand-off document — the backend
migration chain upgrades it, and keeping it proves the chain works.

### BuilderPage state

- `activePageId: string | null`; resolved as
  `definition.pages.find(p => p.id === activePageId) ?? definition.pages[0]`
  so a deleted/stale id degrades to the first page instead of crashing.
- Every visual operation (add, replace, layout, toggle-field, pin-from-Ask)
  routes through the **active page** via a `replacePage(next: Page)` helper.
- On page switch: clear `selectedId` (the selection lives on a page) and
  clear `crossFilter` (cross-filtering is page-local in PowerBI). The
  `drill` map is keyed by visual id — report-unique — so it can stay; other
  pages' entries simply don't render.
- The reset-on-report-change effect also resets `activePageId`.

### PageBar component (`src/reports/PageBar.tsx`)

Tabs along the bottom of the canvas column, PowerBI-style:

- One tab per page; the active tab carries the yellow underline and
  `aria-current="page"`. Clicking a tab switches pages.
- A `+` button (`aria-label="New page"`) appends "Page N" (smallest unused
  number), editors only.
- The **active** tab shows a page-actions button (`aria-label` "Page actions
  for &lt;name&gt;") opening a menu: **Rename** (tab becomes an inline input,
  Enter commits, Escape cancels; renaming to another page's name is refused
  with an inline message), **Duplicate** (new visual ids minted; name
  "Duplicate of &lt;name&gt;", suffixed to stay unique, truncated to 100),
  **Move left / Move right** (disabled at the ends), **Delete** (disabled on
  the last page; two-step confirm following the report-delete precedent).
  Double-clicking the active tab also starts a rename — PBI muscle memory.
- Viewers see plain tabs: switching allowed, every mutation hidden.

Props are granular so tests read plainly: `pages`, `activeId`, `canEdit`,
`onSelect(id)`, `onAdd()`, `onRename(id, name)`, `onDuplicate(id)`,
`onDelete(id)`, `onMove(id, direction)`.

### Filter scopes

`FilterPane` grows the third scope and matches PowerBI's top-to-bottom
order: **this visual** (only when a visual is selected), **this page**,
**all pages**.

- Headings: `Filters on "<visual title>"`, `Filters on this page`,
  `Filters on all pages`.
- Drop ids: `filter:visual`, `filter:page` (new), `filter:report`.
  BuilderPage's `onDragEnd` gains the third branch.
- `effectiveFilters` gains `pageFilters`, composed report → page → visual →
  drill → cross-filter, all still gated by `isActive`.
- `useVisualQuery` options gain `pageFilters`; `CanvasGrid` passes the
  active page's filters through to each tile alongside `reportFilters`.

### Excel export / Connect live

`sheetRequestsFor` becomes pages-aware: one sheet per visual across **all
pages** (whole-report export was the user's sub-project-5 choice), each
sheet composed with its own page's filters. When the report has more than
one page the sheet title is prefixed `<page name> — <visual title>` and the
sheet's context line records the page name. The session cross-filter applies
only to visuals sharing a page with its source visual; drill state applies
wherever its visual id matches.

### Ask panel

Pinning an answer adds the visual to the **active page**. The Ask request
itself is unchanged (it never reads visuals).

## Testing

Backend:
- `migrate` tests: v2→v3 shape (filters move into the page, top-level
  filters emptied, `visuals` key removed), v1→v3 chain, claimed-v2 with
  `pages` passes through untouched.
- `schema` tests: pages required/min 1/max 20, page id + name uniqueness,
  visual-id uniqueness across pages, MAX_VISUALS summed across pages,
  unbound-with-visuals caught on any page, filter-id scopes, hierarchy
  reference checks across pages.
- Read-path test: a stored v2 row served by `GET /api/reports/{id}` comes
  back as v3.
- `import_report` test: a missing field on page 2 (well and filter) fails
  the import.

Frontend:
- `PageBar` component tests: switch, add (naming), rename (commit, cancel,
  duplicate-name refusal), duplicate (new visual ids), delete (last-page
  guard, confirm), move left/right, viewer sees no mutations.
- `filters.ts`: `effectiveFilters` with page scope; `sheetRequestsFor`
  across pages (page prefix, page-local cross-filter).
- `FilterPane`: three scopes render in PBI order, third drop target.
- `BuilderPage` integration: switching pages swaps the canvas; checking a
  Data-pane field creates the visual on the active page; page switch clears
  selection and cross-filter; Save round-trips a two-page definition.
- Existing tests move with the schema (fixtures become v3 or rely on the
  migration chain).

Final gate, per house rule: an **unstubbed browser pass** against the live
API — build a two-page report, filter at all three scopes, rename and
reorder pages, export, and look at the screenshots.
