# Pages & Filter Scopes (7a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A report is a list of pages (switch/add/rename/duplicate/delete/reorder) with PowerBI's three filter scopes: visual → page → all pages.

**Architecture:** Definition schema v3 moves `visuals` and the old page-scope `filters` into `pages[]`; top-level `filters` becomes the all-pages scope. Migration is chained v1→v2→v3 and now also applied on the read path, because v3 is the first structurally breaking version. The frontend routes every visual operation through the active page and threads `pageFilters` through the tile query composition.

**Tech Stack:** FastAPI + pydantic v2 (backend), React 18 + TanStack Query + dnd-kit + vitest/Testing Library (frontend).

**Spec:** `docs/superpowers/specs/2026-08-16-pages-and-filter-scopes-design.md`

## Global Constraints

- Never modify/reorder `frontend/src/query/palette.ts`.
- Frontend typecheck is `npm run typecheck` (tsc -b). Bare `tsc --noEmit` checks nothing.
- Filter values are bound parameters, never SQL text (untouched here, but no task may regress it).
- All copy in sentence case; PowerBI vocabulary: "Filters on this visual" / "Filters on this page" / "Filters on all pages".
- Backend tests: `cd backend && python -m pytest -q`. Frontend: `cd frontend && npx vitest run` and `npm run typecheck`.
- `MAX_PAGES = 20`, page name 1–100 chars, ≥1 page always, `MAX_VISUALS = 50` across all pages, page ids and names unique.

---

### Task 1: Backend migration v2→v3

**Files:**
- Modify: `backend/app/reports/migrate.py` (whole file, small)
- Test: `backend/tests/test_report_migrate.py`

**Interfaces:**
- Produces: `migrate_definition(raw) -> raw'` now upgrades v1 and v2 documents to v3. A claimed-v2 document that already has `"pages"` passes through untouched.

- [ ] **Step 1: Write the failing tests** (append to `test_report_migrate.py`)

```python
def test_v2_becomes_v3_with_one_page():
    v2 = {
        "schemaVersion": 2,
        "name": "R",
        "view": {"database": "D", "schema": "S", "name": "V"},
        "visuals": [{"id": "v1", "type": "bar"}],
        "filters": [{"id": "f1", "field": "C.R", "op": "is", "values": ["EAST"]}],
        "hierarchies": [],
    }
    out = migrate_definition(v2)
    assert out["schemaVersion"] == 3
    assert "visuals" not in out
    page = out["pages"][0]
    assert page["name"] == "Page 1"
    assert page["visuals"] == v2["visuals"]
    # v2's top-level filters were the page scope; the all-pages scope starts empty.
    assert page["filters"] == v2["filters"]
    assert out["filters"] == []


def test_v1_chains_through_to_v3():
    v1 = {
        "schemaVersion": 1,
        "name": "R",
        "view": {"database": "D", "schema": "S", "name": "V"},
        "visuals": [{"id": "v1", "type": "bar"}],
    }
    out = migrate_definition(v1)
    assert out["schemaVersion"] == 3
    assert out["pages"][0]["visuals"][0]["filters"] == []
    assert out["hierarchies"] == []


def test_claimed_v2_with_pages_passes_through_untouched():
    weird = {"schemaVersion": 2, "pages": [{"id": "p1"}], "visuals": []}
    assert migrate_definition(weird) is weird
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python -m pytest tests/test_report_migrate.py -q`
Expected: the three new tests FAIL (v2 passes through unchanged today).

- [ ] **Step 3: Implement** — replace the body of `migrate.py` below the docstring:

```python
def migrate_definition(raw: object) -> object:
    """Return `raw` upgraded to the current schema version. Never mutates it."""
    if not isinstance(raw, dict):
        return raw
    if raw.get("schemaVersion") == 1:
        raw = _v1_to_v2(raw)
    if raw.get("schemaVersion") == 2:
        raw = _v2_to_v3(raw)
    return raw


def _v1_to_v2(raw: dict) -> dict:
    upgraded = {
        **raw,
        "schemaVersion": 2,
        # setdefault semantics, not overwrite: a hand-written v1 document that
        # already carries these keys keeps what it says.
        "filters": raw.get("filters", []),
        "hierarchies": raw.get("hierarchies", []),
    }
    visuals = raw.get("visuals")
    if isinstance(visuals, list):
        upgraded["visuals"] = [
            {**v, "filters": v.get("filters", [])} if isinstance(v, dict) else v
            for v in visuals
        ]
    return upgraded


def _v2_to_v3(raw: dict) -> dict:
    if "pages" in raw:
        # Not a shape this migration understands; let the validator name it.
        return raw
    upgraded = {
        **raw,
        "schemaVersion": 3,
        "pages": [
            {
                "id": "p1",
                "name": "Page 1",
                "visuals": raw.get("visuals", []),
                # v2's top-level filters were labelled "Filters on this page"
                # in the UI, so they belong to the migrated page; the new
                # all-pages scope starts empty.
                "filters": raw.get("filters", []),
            }
        ],
        "filters": [],
    }
    upgraded.pop("visuals", None)
    return upgraded
```

- [ ] **Step 4: Run the migrate tests**

Run: `cd backend && python -m pytest tests/test_report_migrate.py -q`
Expected: PASS. Existing v1→v2 tests that asserted `out["schemaVersion"] == 2` will now see 3 — update those assertions to follow the chain (they assert on the same keys, one version later; the "already v2 passes through" style test becomes the `pages` pass-through test above).

- [ ] **Step 5: Commit**

```bash
git add backend/app/reports/migrate.py backend/tests/test_report_migrate.py
git commit -m "feat: migrate report definitions v2 to v3 (pages)"
```

---

### Task 2: Backend schema v3

**Files:**
- Modify: `backend/app/reports/schema.py`
- Test: `backend/tests/test_report_schema.py` (plus fixture fallout in `tests/test_report_routes.py`, `tests/test_report_import.py`, `tests/test_models.py`, `tests/integration/test_reports_it.py`)

**Interfaces:**
- Produces: `SCHEMA_VERSION = 3`, `MAX_PAGES = 20`, class `Page(id, name, visuals, filters)`, `ReportDefinition.pages: list[Page]` (no `.visuals`), helper `ReportDefinition.all_visuals()` yielding every visual on every page. Consumed by Task 3.

- [ ] **Step 1: Update the shared fixture and write failing tests.** In `test_report_schema.py`, `valid_doc` becomes v3 (tests that need a raw-visual override keep working through a `page` kwarg):

```python
def valid_visual(**overrides):
    visual = {
        "id": "v1",
        "type": "bar",
        "title": "Revenue by region",
        "layout": {"x": 0, "y": 0, "w": 6, "h": 6},
        "wells": {"axis": ["C.REGION"], "legend": [], "values": ["A.REV"]},
        "options": {"stacked": False},
    }
    visual.update(overrides)
    return visual


def valid_doc(**overrides):
    doc = {
        "schemaVersion": SCHEMA_VERSION,
        "name": "Sales overview",
        "view": {"database": "ANALYTICS", "schema": "PUBLIC", "name": "SALES"},
        "canvas": {"columns": 12, "rowHeight": 40},
        "pages": [
            {"id": "p1", "name": "Page 1", "visuals": [valid_visual()], "filters": []}
        ],
        "filters": [],
    }
    doc.update(overrides)
    return doc
```

New tests to add:

```python
def test_requires_at_least_one_page():
    with pytest.raises(ApiError):
        parse_definition(valid_doc(pages=[]))


def test_rejects_more_than_max_pages():
    pages = [
        {"id": f"p{i}", "name": f"Page {i}", "visuals": [], "filters": []}
        for i in range(MAX_PAGES + 1)
    ]
    with pytest.raises(ApiError) as exc:
        parse_definition(valid_doc(pages=pages))
    assert "page" in exc.value.message.lower()


def test_rejects_duplicate_page_ids_and_names():
    def page(pid, name):
        return {"id": pid, "name": name, "visuals": [], "filters": []}

    with pytest.raises(ApiError):
        parse_definition(valid_doc(pages=[page("p1", "A"), page("p1", "B")]))
    with pytest.raises(ApiError):
        parse_definition(valid_doc(pages=[page("p1", "A"), page("p2", "A")]))


def test_rejects_duplicate_visual_ids_across_pages():
    doc = valid_doc(
        pages=[
            {"id": "p1", "name": "A", "visuals": [valid_visual()], "filters": []},
            {"id": "p2", "name": "B", "visuals": [valid_visual()], "filters": []},
        ]
    )
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert "v1" in exc.value.message


def test_max_visuals_counts_across_pages():
    def visuals(start, count):
        return [valid_visual(id=f"v{start + i}") for i in range(count)]

    doc = valid_doc(
        pages=[
            {"id": "p1", "name": "A", "visuals": visuals(0, 30), "filters": []},
            {"id": "p2", "name": "B", "visuals": visuals(30, 21), "filters": []},
        ]
    )
    with pytest.raises(ApiError) as exc:
        parse_definition(doc)
    assert str(MAX_VISUALS) in exc.value.message


def test_unbound_view_rejected_when_any_page_holds_visuals():
    doc = valid_doc(
        view={"database": "", "schema": "", "name": ""},
        pages=[
            {"id": "p1", "name": "A", "visuals": [], "filters": []},
            {"id": "p2", "name": "B", "visuals": [valid_visual()], "filters": []},
        ],
    )
    with pytest.raises(ApiError):
        parse_definition(doc)


def test_page_filter_ids_are_a_scope_of_their_own():
    f = {"id": "f1", "field": "C.REGION", "op": "is", "values": ["EAST"]}
    # Same id on two DIFFERENT pages is fine; twice on ONE page is not.
    ok = valid_doc(
        pages=[
            {"id": "p1", "name": "A", "visuals": [valid_visual()], "filters": [f]},
            {"id": "p2", "name": "B", "visuals": [], "filters": [dict(f)]},
        ]
    )
    parse_definition(ok)
    with pytest.raises(ApiError):
        parse_definition(
            valid_doc(
                pages=[
                    {
                        "id": "p1",
                        "name": "A",
                        "visuals": [valid_visual()],
                        "filters": [f, dict(f)],
                    }
                ]
            )
        )
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd backend && python -m pytest tests/test_report_schema.py -q`
Expected: FAIL — `pages` is an unknown key on the v2 model.

- [ ] **Step 3: Implement in `schema.py`.**

Constants and model changes:

```python
SCHEMA_VERSION = 3
MAX_PAGES = 20
MAX_PAGE_NAME = 100
```

Add after `Visual` (before `CanvasSettings`):

```python
class Page(_Strict):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=MAX_PAGE_NAME)
    visuals: list[Visual] = Field(default_factory=list)
    filters: FilterList = Field(default_factory=list)
```

`ReportDefinition` replaces `visuals` with `pages` and gains the iterator:

```python
class ReportDefinition(_Strict):
    schemaVersion: int
    name: str = Field(min_length=1, max_length=200)
    view: ViewRef
    canvas: CanvasSettings = Field(default_factory=CanvasSettings)
    pages: list[Page] = Field(min_length=1, max_length=MAX_PAGES)
    #: The all-pages scope. Page and visual scopes live on their owners.
    filters: FilterList = Field(default_factory=list)
    hierarchies: list[Hierarchy] = Field(
        default_factory=list, max_length=MAX_HIERARCHIES
    )

    def all_visuals(self):
        for page in self.pages:
            yield from page.visuals
```

In `parse_definition`:
- Replace the pre-parse `visuals` count with a pages-aware one:

```python
    pages = raw.get("pages")
    if isinstance(pages, list):
        total = sum(
            len(p["visuals"])
            for p in pages
            if isinstance(p, dict) and isinstance(p.get("visuals"), list)
        )
        if total > MAX_VISUALS:
            raise _invalid(f"A report may hold at most {MAX_VISUALS} visuals")
```

- Unbound check: `if is_unbound and any(page.visuals for page in definition.pages):` (message unchanged).
- The visual loop iterates `definition.all_visuals()` instead of `definition.visuals`.
- Add page uniqueness checks right before the visual loop:

```python
    seen_page_ids: set[str] = set()
    seen_page_names: set[str] = set()
    for page in definition.pages:
        if page.id in seen_page_ids:
            raise _invalid(f"Duplicate page id {page.id!r}")
        seen_page_ids.add(page.id)
        if page.name in seen_page_names:
            raise _invalid(f"Duplicate page name {page.name!r}")
        seen_page_names.add(page.name)
```

- `_check_unique_filter_ids` grows the page scope:

```python
    scopes: list[tuple[str, list]] = [("report", list(definition.filters))]
    scopes += [(f"page {p.id!r}", list(p.filters)) for p in definition.pages]
    scopes += [
        (f"visual {v.id!r}", list(v.filters)) for v in definition.all_visuals()
    ]
```

- `_check_hierarchies`'s visual loop iterates `definition.all_visuals()`.

- [ ] **Step 4: Fix fixture fallout, run the whole backend suite.** Every test that builds a definition dict with top-level `visuals` either (a) claims `schemaVersion: 1`/`2` and now migrates cleanly — only its assertions on `parsed.visuals` need to become `parsed.pages[0].visuals` — or (b) claims the current version and must wrap its visuals in `pages` like `valid_doc` above. `grep -rn "schemaVersion" backend/tests` and update each. Accessors change mechanically: `definition.visuals[0]` → `definition.pages[0].visuals[0]`.

Run: `cd backend && python -m pytest -q`
Expected: PASS, no skips beyond the known gated ones.

- [ ] **Step 5: Commit**

```bash
git add backend/app/reports/schema.py backend/tests
git commit -m "feat: report definition schema v3 -- pages with page-scope filters"
```

---

### Task 3: Read-path migration and import over pages

**Files:**
- Modify: `backend/app/reports/routes.py` (`_detail`), `backend/app/reports/service.py` (`import_report`)
- Test: `backend/tests/test_report_routes.py`, `backend/tests/test_report_import.py`

**Interfaces:**
- Consumes: `migrate_definition` (Task 1), `ReportDefinition.pages` / `all_visuals()` (Task 2).
- Produces: `GET /api/reports/{id}` always serves a current-version definition, even for rows stored before the bump.

- [ ] **Step 1: Failing tests.**

In `test_report_routes.py` (using that file's existing client/report fixtures):

```python
def test_get_serves_a_stored_v2_definition_as_v3(client, db_session):
    # Simulate a row written before the v3 bump: store a v2 document directly.
    created = client.post(
        "/api/reports", json={"definition": valid_doc()}
    ).json()
    report = db_session.get(Report, uuid.UUID(created["id"]))
    report.definition = {
        "schemaVersion": 2,
        "name": "Old",
        "view": {"database": "D", "schema": "S", "name": "V"},
        "visuals": [],
        "filters": [],
        "hierarchies": [],
    }
    db_session.commit()

    got = client.get(f"/api/reports/{created['id']}").json()
    assert got["definition"]["schemaVersion"] == 3
    assert got["definition"]["pages"][0]["name"] == "Page 1"
    assert "visuals" not in got["definition"]
```

(Adapt fixture names to the file's existing ones — it already creates reports through the API in several tests; reuse its session/client pattern exactly.)

In `test_report_import.py`, extend the missing-fields test so the missing reference sits on a second page's visual well AND a page filter:

```python
def test_import_validates_fields_on_every_page(...existing fixtures...):
    doc = valid_doc(
        pages=[
            {"id": "p1", "name": "A", "visuals": [valid_visual()], "filters": []},
            {
                "id": "p2",
                "name": "B",
                "visuals": [
                    valid_visual(
                        id="v2",
                        wells={"axis": ["C.REGION"], "legend": [], "values": ["A.GHOST"]},
                    )
                ],
                "filters": [
                    {"id": "f9", "field": "C.PHANTOM", "op": "is", "values": ["X"]}
                ],
            },
        ]
    )
    # ... post to /api/reports/import as the file's other tests do ...
    assert response.status_code == 400
    body = response.json()
    assert "A.GHOST" in body["detail"]["message"]
    assert "C.PHANTOM" in body["detail"]["message"]
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python -m pytest tests/test_report_routes.py tests/test_report_import.py -q`
Expected: read-path test FAILS (raw v2 served); import test FAILS (page filters never validated) or errors on `definition.visuals`.

- [ ] **Step 3: Implement.**

`routes.py`: import `migrate_definition` and change `_detail`:

```python
from app.reports.migrate import migrate_definition

def _detail(report: Report, *, workspace: Workspace | None, role: str) -> dict:
    return {
        **_summary(report, workspace=workspace, role=role),
        # Migrate on the way out, not just on save: v3 is the first
        # structurally breaking version, and a row stored before the bump
        # must not reach the frontend in a shape it no longer reads.
        # Migrate only -- parse_definition's validation could turn a stored
        # document into a 400 on read, locking its owner out of fixing it.
        "definition": migrate_definition(report.definition),
    }
```

`service.py` `import_report` — replace the report-filters + visuals loops with:

```python
    for f in definition.filters:
        if f.field.upper() not in known:
            missing.append(f.field)
    for page in definition.pages:
        # A page filter names a field exactly as a well or visual filter does.
        for f in page.filters:
            if f.field.upper() not in known:
                missing.append(f.field)
        for visual in page.visuals:
            dimensions, metrics = wells_to_query(
                visual.type, visual.wells, hierarchies=hierarchy_levels
            )
            for ref in dimensions + metrics:
                if ref.upper() not in known:
                    missing.append(ref)
            for f in visual.filters:
                if f.field.upper() not in known:
                    missing.append(f.field)
```

- [ ] **Step 4: Full backend suite**

Run: `cd backend && python -m pytest -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/reports/routes.py backend/app/reports/service.py backend/tests
git commit -m "feat: serve stored definitions migrated; validate imports across pages"
```

---

### Task 4: Frontend filter composition over pages

**Files:**
- Modify: `frontend/src/api/types.ts`, `frontend/src/reports/filters.ts`
- Test: `frontend/src/reports/filters.test.ts`

**Interfaces:**
- Produces: `interface Page { id; name; visuals; filters }`; `ReportDefinition.pages: Page[]` (no `.visuals`); `effectiveFilters({ reportFilters, pageFilters?, visual, drill?, crossFilter? })`; `sheetRequestsFor({ pages, reportFilters, hierarchies, drill, crossFilter, titleOf, wellsToQuery })`.
- NOTE: after this task the frontend will not typecheck until Tasks 5–8 land; run `npx vitest run src/reports/filters.test.ts` only, and hold `npm run typecheck` until Task 8.

- [ ] **Step 1: Types.** In `types.ts` replace the `ReportDefinition` block:

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
  /** The all-pages scope. Page and visual scopes live on their owners. */
  filters: Filter[];
  hierarchies: Hierarchy[];
}
```

- [ ] **Step 2: Failing tests** (append to `filters.test.ts`; reuse its existing visual/filter helpers):

```ts
describe("effectiveFilters with a page scope", () => {
  it("composes report, page, visual, in that order", () => {
    const visual = makeVisual({ filters: [active("C.C", "v")] });
    const out = effectiveFilters({
      reportFilters: [active("C.A", "r")],
      pageFilters: [active("C.B", "p")],
      visual,
    });
    expect(out.map((f) => f.field)).toEqual(["C.A", "C.B", "C.C"]);
  });

  it("drops inactive page filters like every other scope", () => {
    const visual = makeVisual({});
    const out = effectiveFilters({
      reportFilters: [],
      pageFilters: [{ id: "p1", field: "C.B", op: "is", values: [] }],
      visual,
    });
    expect(out).toEqual([]);
  });
});

describe("sheetRequestsFor across pages", () => {
  const pages: Page[] = [
    { id: "p1", name: "Sales", visuals: [makeVisual({ id: "v1" })], filters: [active("C.P1", "pf")] },
    { id: "p2", name: "Ops", visuals: [makeVisual({ id: "v2" })], filters: [] },
  ];

  it("emits one sheet per visual on every page, page-prefixed and page-filtered", () => {
    const sheets = sheetRequestsFor({
      pages,
      reportFilters: [],
      hierarchies: [],
      drill: {},
      crossFilter: null,
      titleOf: () => "T",
      wellsToQuery: () => ({ dimensions: [], metrics: [] }),
    });
    expect(sheets.map((s) => s.title)).toEqual(["Sales — T", "Ops — T"]);
    expect(sheets[0].filters.map((f) => f.field)).toContain("C.P1");
    expect(sheets[1].filters).toEqual([]);
    expect(sheets[0].context).toContain("Page: Sales");
  });

  it("keeps the cross-filter on its own page only", () => {
    const crossFilter = { sourceVisualId: "v1", field: "C.R", value: "EAST" };
    const sheets = sheetRequestsFor({
      pages, reportFilters: [], hierarchies: [], drill: {}, crossFilter,
      titleOf: () => "T",
      wellsToQuery: () => ({ dimensions: [], metrics: [] }),
    });
    // v1 is the source (never filters itself); v2 is on another page.
    expect(sheets[0].filters.map((f) => f.field)).not.toContain("C.R");
    expect(sheets[1].filters.map((f) => f.field)).not.toContain("C.R");
  });

  it("does not prefix titles on a single-page report", () => {
    const sheets = sheetRequestsFor({
      pages: [pages[0]], reportFilters: [], hierarchies: [], drill: {},
      crossFilter: null, titleOf: () => "T",
      wellsToQuery: () => ({ dimensions: [], metrics: [] }),
    });
    expect(sheets[0].title).toBe("T");
  });
});
```

(`active(field, id)` = `{ id, field, op: "is", values: ["x"] }` — add the tiny helper if the file lacks one.)

- [ ] **Step 3: Run to verify they fail**

Run: `cd frontend && npx vitest run src/reports/filters.test.ts`
Expected: FAIL — no `pageFilters` param, `sheetRequestsFor` takes `visuals`.

- [ ] **Step 4: Implement in `filters.ts`.**

`effectiveFilters` gains the page scope:

```ts
/** The composed filter set for one visual: all-pages scope AND its page's
 *  AND its own AND the drill path AND any active cross-filter. Intersection,
 *  in that order. */
export function effectiveFilters({
  reportFilters,
  pageFilters = [],
  visual,
  drill,
  crossFilter,
}: {
  reportFilters: Filter[];
  pageFilters?: Filter[];
  visual: Visual;
  drill?: DrillState;
  crossFilter?: CrossFilter | null;
}): Filter[] {
  const composed: Filter[] = [
    ...reportFilters,
    ...pageFilters,
    ...(visual.filters ?? []),
    ...drillFilters(drill),
  ].filter(isActive);
  if (crossFilter && crossFilter.sourceVisualId !== visual.id) {
    composed.push({
      id: `xf:${crossFilter.field}`,
      field: crossFilter.field,
      op: "is",
      values: [crossFilter.value],
    });
  }
  return composed;
}
```

`sheetRequestsFor` becomes pages-aware (import `Page` from types):

```ts
export function sheetRequestsFor({
  pages,
  reportFilters,
  hierarchies,
  drill,
  crossFilter,
  titleOf,
  wellsToQuery,
}: {
  pages: Page[];
  reportFilters: Filter[];
  hierarchies: Hierarchy[];
  drill: Record<string, DrillState>;
  crossFilter: CrossFilter | null;
  titleOf: (visual: Visual, wells: Record<string, string[]>) => string;
  wellsToQuery: (
    type: string,
    wells: Record<string, string[]>,
  ) => { dimensions: string[]; metrics: string[] };
}): SheetRequest[] {
  const multi = pages.length > 1;
  // Cross-filtering is page-local: the selection constrains only visuals
  // sharing a page with its source.
  const sourcePage = crossFilter
    ? pages.find((p) => p.visuals.some((v) => v.id === crossFilter.sourceVisualId))
    : undefined;

  return pages.flatMap((page) => {
    const pageCross = page === sourcePage ? crossFilter : null;
    return page.visuals.map((visual) => {
      const own = drill[visual.id];
      const wells = resolveWells(visual.wells, hierarchies, own);
      const { dimensions, metrics } = wellsToQuery(visual.type, wells);

      const context: string[] = [];
      if (multi) context.push(`Page: ${page.name}`);
      if (own?.path.length) {
        context.push(`Drilled into ${own.path.map((s) => s.value).join(" > ")}`);
      }
      if (pageCross && pageCross.sourceVisualId !== visual.id) {
        context.push(`Filtered by ${pageCross.field} = ${pageCross.value}`);
      }

      const title = titleOf(visual, wells);
      return {
        title: multi ? `${page.name} — ${title}` : title,
        dimensions,
        metrics,
        filters: effectiveFilters({
          reportFilters,
          pageFilters: page.filters,
          visual,
          drill: own,
          crossFilter: pageCross,
        }),
        orderBy: [],
        context: context.join("; "),
      };
    });
  });
}
```

- [ ] **Step 5: Run filters tests only** (typecheck is deferred; other files still reference `definition.visuals`)

Run: `cd frontend && npx vitest run src/reports/filters.test.ts`
Expected: PASS (update any existing `sheetRequestsFor` tests to the pages signature).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/reports/filters.ts frontend/src/reports/filters.test.ts
git commit -m "feat: page type and page-scope filter composition"
```

---

### Task 5: Thread pageFilters through the tile query

**Files:**
- Modify: `frontend/src/reports/useVisualQuery.ts`, `frontend/src/reports/VisualTile.tsx`, `frontend/src/reports/CanvasGrid.tsx`
- Test: `frontend/src/reports/useVisualQuery.test.tsx`

**Interfaces:**
- Consumes: `effectiveFilters` with `pageFilters` (Task 4).
- Produces: `useVisualQuery(view, visual, { reportFilters?, pageFilters?, hierarchies?, drill?, crossFilter? })`; `VisualTile` and `CanvasGrid` each accept `pageFilters?: Filter[]` (default `[]`) and pass it down.

- [ ] **Step 1: Failing test** (append to `useVisualQuery.test.tsx`, following its existing render/fetch-stub pattern):

```tsx
it("sends page filters to the API alongside report filters", async () => {
  // Render the hook with:
  //   reportFilters: [{ id: "r", field: "C.A", op: "is", values: ["1"] }]
  //   pageFilters:   [{ id: "p", field: "C.B", op: "is", values: ["2"] }]
  // and assert the POST body's filters contain BOTH fields, report first.
});
```

Write it concretely in the file's established style (it already asserts on `fetch` bodies).

- [ ] **Step 2: Verify it fails**, then implement: add `pageFilters = []` to the `Options` interface and destructuring in `useVisualQuery`, pass it to `effectiveFilters`. The query key already includes `filters` (the composed list), so no key change is needed. In `VisualTile.tsx` add `pageFilters?: Filter[]` to props, forward into `useVisualQuery`. In `CanvasGrid.tsx` add `pageFilters = []` to props and forward to each `VisualTile`.

- [ ] **Step 3: Run**

Run: `cd frontend && npx vitest run src/reports/useVisualQuery.test.tsx src/reports/VisualTile.test.tsx src/reports/CanvasGrid.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/reports/useVisualQuery.ts frontend/src/reports/VisualTile.tsx frontend/src/reports/CanvasGrid.tsx frontend/src/reports/useVisualQuery.test.tsx
git commit -m "feat: page filters reach every tile query"
```

---

### Task 6: FilterPane grows the third scope

**Files:**
- Modify: `frontend/src/reports/FilterPane.tsx`
- Test: `frontend/src/reports/FilterPane.test.tsx`

**Interfaces:**
- Produces: props `{ view, fields, reportFilters, pageFilters, visualFilters, selectedVisualTitle, onChangeReport, onChangePage, onChangeVisual }`; exported drop ids `REPORT_DROP_ID = "filter:report"`, `PAGE_DROP_ID = "filter:page"`, `VISUAL_DROP_ID = "filter:visual"`. Scope order top-to-bottom mirrors PowerBI: visual, page, all pages.

- [ ] **Step 1: Failing tests.** Update the `props` fixture with `pageFilters: [] as Filter[]` and `onChangePage: () => {}`. Add:

```tsx
it("renders the three scopes in PowerBI order when a visual is selected", () => {
  wrap(
    <FilterPane
      {...props}
      visualFilters={[]}
      selectedVisualTitle="Revenue by region"
    />,
  );
  const headings = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
  expect(headings).toEqual([
    'Filters on "Revenue by region"',
    "Filters on this page",
    "Filters on all pages",
  ]);
});

it("adds an all-pages filter for a chosen field", async () => {
  const onChangeReport = vi.fn();
  wrap(<FilterPane {...props} onChangeReport={onChangeReport} />);
  await userEvent.selectOptions(
    screen.getByLabelText(/add a filter on all pages/i),
    "CUSTOMERS.REGION",
  );
  expect(onChangeReport).toHaveBeenCalledWith([
    expect.objectContaining({ field: "CUSTOMERS.REGION", op: "is", values: [] }),
  ]);
});

it("exposes the page scope as a drop target", () => {
  wrap(<FilterPane {...props} />);
  expect(screen.getByTestId("filter-drop-page")).toBeInTheDocument();
});
```

Existing tests that said "on this page" for the report scope now bind to the page scope: point their `onChange*` assertions at `onChangePage` (the labels they query stay valid, which is the point — the wording followed the meaning).

- [ ] **Step 2: Verify failing**, then implement: add `PAGE_DROP_ID = "filter:page"`. `FilterScope` is already generic; the default export renders three `FilterScope`s — visual (only when `visualFilters !== null`) first, then page, then all pages:

```tsx
export default function FilterPane({
  view, fields, reportFilters, pageFilters, visualFilters,
  selectedVisualTitle, onChangeReport, onChangePage, onChangeVisual,
}: Props) {
  return (
    <section className="filter-pane">
      <h3>Filters</h3>
      {visualFilters !== null && (
        <FilterScope
          heading={`Filters on "${selectedVisualTitle || "this visual"}"`}
          emptyText="No filters on this visual. It shows everything the page and report filters allow."
          addLabel="Add a filter on this visual"
          dropId={VISUAL_DROP_ID}
          testId="filter-drop-visual"
          filters={visualFilters}
          fields={fields}
          view={view}
          onChange={onChangeVisual}
        />
      )}
      <FilterScope
        heading="Filters on this page"
        emptyText="No filters on this page. Every visual shows all its data."
        addLabel="Add a filter on this page"
        dropId={PAGE_DROP_ID}
        testId="filter-drop-page"
        filters={pageFilters}
        fields={fields}
        view={view}
        onChange={onChangePage}
      />
      <FilterScope
        heading="Filters on all pages"
        emptyText="No filters across pages."
        addLabel="Add a filter on all pages"
        dropId={REPORT_DROP_ID}
        testId="filter-drop-report"
        filters={reportFilters}
        fields={fields}
        view={view}
        onChange={onChangeReport}
      />
    </section>
  );
}
```

- [ ] **Step 3: Run**

Run: `cd frontend && npx vitest run src/reports/FilterPane.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/reports/FilterPane.tsx frontend/src/reports/FilterPane.test.tsx
git commit -m "feat: three filter scopes in the pane, PowerBI order"
```

---

### Task 7: PageBar component

**Files:**
- Create: `frontend/src/reports/PageBar.tsx`
- Test: `frontend/src/reports/PageBar.test.tsx`
- Modify: `frontend/src/index.css` (page-bar additions)

**Interfaces:**
- Produces: default export `PageBar` with props `{ pages: Page[]; activeId: string; canEdit: boolean; onSelect(id); onAdd(); onRename(id, name); onDuplicate(id); onDelete(id); onMove(id, direction: -1 | 1) }`. Rename validation (empty → cancel, duplicate name → inline alert) lives here; every structural mutation is delegated up.

- [ ] **Step 1: Failing tests** (`PageBar.test.tsx`):

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Page } from "../api/types";
import PageBar from "./PageBar";

const pages: Page[] = [
  { id: "p1", name: "Overview", visuals: [], filters: [] },
  { id: "p2", name: "Detail", visuals: [], filters: [] },
];

const props = {
  pages,
  activeId: "p1",
  canEdit: true,
  onSelect: () => {},
  onAdd: () => {},
  onRename: () => {},
  onDuplicate: () => {},
  onDelete: () => {},
  onMove: () => {},
};

describe("PageBar", () => {
  it("marks the active tab and switches on click", async () => {
    const onSelect = vi.fn();
    render(<PageBar {...props} onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await userEvent.click(screen.getByRole("button", { name: "Detail" }));
    expect(onSelect).toHaveBeenCalledWith("p2");
  });

  it("adds a page", async () => {
    const onAdd = vi.fn();
    render(<PageBar {...props} onAdd={onAdd} />);
    await userEvent.click(screen.getByRole("button", { name: /new page/i }));
    expect(onAdd).toHaveBeenCalled();
  });

  it("renames through the menu, committing on Enter", async () => {
    const onRename = vi.fn();
    render(<PageBar {...props} onRename={onRename} />);
    await userEvent.click(screen.getByRole("button", { name: /page actions/i }));
    await userEvent.click(screen.getByRole("button", { name: /rename/i }));
    const input = screen.getByLabelText(/page name/i);
    await userEvent.clear(input);
    await userEvent.type(input, "Summary{Enter}");
    expect(onRename).toHaveBeenCalledWith("p1", "Summary");
  });

  it("refuses a rename that collides with another page", async () => {
    const onRename = vi.fn();
    render(<PageBar {...props} onRename={onRename} />);
    await userEvent.click(screen.getByRole("button", { name: /page actions/i }));
    await userEvent.click(screen.getByRole("button", { name: /rename/i }));
    const input = screen.getByLabelText(/page name/i);
    await userEvent.clear(input);
    await userEvent.type(input, "Detail{Enter}");
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/already exists/i);
  });

  it("cancels a rename on Escape", async () => {
    const onRename = vi.fn();
    render(<PageBar {...props} onRename={onRename} />);
    await userEvent.click(screen.getByRole("button", { name: /page actions/i }));
    await userEvent.click(screen.getByRole("button", { name: /rename/i }));
    await userEvent.type(screen.getByLabelText(/page name/i), "{Escape}");
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/page name/i)).toBeNull();
  });

  it("starts a rename on double-clicking the active tab", async () => {
    render(<PageBar {...props} />);
    await userEvent.dblClick(screen.getByRole("button", { name: "Overview" }));
    expect(screen.getByLabelText(/page name/i)).toHaveValue("Overview");
  });

  it("duplicates and moves through the menu", async () => {
    const onDuplicate = vi.fn();
    const onMove = vi.fn();
    render(<PageBar {...props} onDuplicate={onDuplicate} onMove={onMove} />);
    await userEvent.click(screen.getByRole("button", { name: /page actions/i }));
    await userEvent.click(screen.getByRole("button", { name: /duplicate/i }));
    expect(onDuplicate).toHaveBeenCalledWith("p1");
    await userEvent.click(screen.getByRole("button", { name: /page actions/i }));
    expect(screen.getByRole("button", { name: /move left/i })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /move right/i }));
    expect(onMove).toHaveBeenCalledWith("p1", 1);
  });

  it("deletes only after a confirm, never the last page", async () => {
    const onDelete = vi.fn();
    render(<PageBar {...props} onDelete={onDelete} />);
    await userEvent.click(screen.getByRole("button", { name: /page actions/i }));
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(onDelete).not.toHaveBeenCalled(); // confirm first
    await userEvent.click(screen.getByRole("button", { name: /delete page/i }));
    expect(onDelete).toHaveBeenCalledWith("p1");

    onDelete.mockClear();
    render(
      <PageBar {...props} pages={[pages[0]]} onDelete={onDelete} />,
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: /page actions/i }).at(-1)!,
    );
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeDisabled();
  });

  it("shows a viewer plain tabs: switching only", () => {
    render(<PageBar {...props} canEdit={false} />);
    expect(screen.queryByRole("button", { name: /new page/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /page actions/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Verify failing** (module does not exist), then implement `PageBar.tsx`:

```tsx
import { useState } from "react";
import type { Page } from "../api/types";

interface Props {
  pages: Page[];
  activeId: string;
  canEdit: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
}

export default function PageBar({
  pages, activeId, canEdit,
  onSelect, onAdd, onRename, onDuplicate, onDelete, onMove,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const index = pages.findIndex((p) => p.id === activeId);
  const active = pages[index];

  const startRename = () => {
    if (!active) return;
    setDraft(active.name);
    setRenaming(true);
    setRenameError(null);
    setMenuOpen(false);
  };

  const commitRename = () => {
    if (!active) return;
    const name = draft.trim();
    // An empty name is a cancel, not an error -- there is nothing to keep.
    if (!name || name === active.name) {
      setRenaming(false);
      setRenameError(null);
      return;
    }
    if (pages.some((p) => p.id !== active.id && p.name === name)) {
      setRenameError(`A page named "${name}" already exists.`);
      return;
    }
    onRename(active.id, name);
    setRenaming(false);
    setRenameError(null);
  };

  return (
    <div className="page-bar">
      {pages.map((page) => {
        const isActive = page.id === activeId;
        if (isActive && renaming) {
          return (
            <span className="page-rename" key={page.id}>
              <input
                aria-label="Page name"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") {
                    setRenaming(false);
                    setRenameError(null);
                  }
                }}
                onBlur={commitRename}
              />
              {renameError && <span role="alert">{renameError}</span>}
            </span>
          );
        }
        return (
          <button
            key={page.id}
            type="button"
            className={isActive ? "page-tab active" : "page-tab"}
            aria-current={isActive ? "page" : undefined}
            onClick={() => onSelect(page.id)}
            onDoubleClick={() => {
              if (canEdit && isActive) startRename();
            }}
          >
            {page.name}
          </button>
        );
      })}
      {canEdit && (
        <button
          type="button"
          className="page-add"
          aria-label="New page"
          title="New page"
          onClick={onAdd}
        >
          +
        </button>
      )}
      {canEdit && active && (
        <span className="page-actions">
          <button
            type="button"
            className="page-menu-toggle"
            aria-label={`Page actions for ${active.name}`}
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((open) => !open);
              setConfirming(false);
            }}
          >
            ⌄
          </button>
          {menuOpen && !confirming && (
            <span className="page-menu" role="group" aria-label="Page actions">
              <button type="button" onClick={startRename}>Rename</button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onDuplicate(active.id);
                }}
              >
                Duplicate
              </button>
              <button
                type="button"
                disabled={index <= 0}
                onClick={() => {
                  setMenuOpen(false);
                  onMove(active.id, -1);
                }}
              >
                Move left
              </button>
              <button
                type="button"
                disabled={index >= pages.length - 1}
                onClick={() => {
                  setMenuOpen(false);
                  onMove(active.id, 1);
                }}
              >
                Move right
              </button>
              <button
                type="button"
                disabled={pages.length <= 1}
                onClick={() => setConfirming(true)}
              >
                Delete
              </button>
            </span>
          )}
          {menuOpen && confirming && (
            <span className="page-menu" role="dialog" aria-label="Confirm delete page">
              <span>Delete "{active.name}"? Its visuals go with it.</span>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setConfirming(false);
                  onDelete(active.id);
                }}
              >
                Delete page
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </span>
          )}
        </span>
      )}
    </div>
  );
}
```

CSS additions in `index.css`, next to the existing `.page-bar`/`.page-tab` rules:

```css
.page-add {
  border: none;
  background: none;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 14px;
  color: var(--ink);
}
.page-add:hover { background: var(--chrome); }
.page-actions { position: relative; }
.page-menu-toggle {
  border: none;
  background: none;
  padding: 4px 6px;
  cursor: pointer;
  color: var(--ink);
}
.page-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: #fff;
  border: 1px solid var(--border);
  box-shadow: var(--tile-shadow);
  padding: 6px;
  min-width: 160px;
  z-index: 30;
}
.page-menu button {
  background: none;
  border: none;
  color: var(--ink);
  text-align: left;
  padding: 6px 8px;
  font-size: 13px;
  cursor: pointer;
}
.page-menu button:hover:not(:disabled) { background: var(--chrome); }
.page-menu button:disabled { color: #a19f9d; cursor: default; }
.page-rename input { font-size: 13px; padding: 4px 8px; }
```

- [ ] **Step 3: Run**

Run: `cd frontend && npx vitest run src/reports/PageBar.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/reports/PageBar.tsx frontend/src/reports/PageBar.test.tsx frontend/src/index.css
git commit -m "feat: PageBar -- switch, add, rename, duplicate, move, delete"
```

---

### Task 8: BuilderPage routes everything through the active page

**Files:**
- Modify: `frontend/src/reports/BuilderPage.tsx`, `frontend/src/reports/ReportListPage.tsx`
- Test: `frontend/src/reports/BuilderPage.test.tsx`, `frontend/src/reports/ReportListPage.test.tsx`

**Interfaces:**
- Consumes: everything above. `ExplorerPage` stays on its v1 hand-off document deliberately — the backend migration chain upgrades it, and keeping it proves the chain works.

- [ ] **Step 1: `ReportListPage.blankDefinition` becomes v3:**

```ts
function blankDefinition(name: string): ReportDefinition {
  return {
    // Bumped with the backend. Older documents are still accepted --
    // parse_definition migrates them -- but there is no reason to write one.
    schemaVersion: 3,
    name,
    view: { database: "", schema: "", name: "" },
    canvas: { columns: 12, rowHeight: 40 },
    pages: [{ id: "p1", name: "Page 1", visuals: [], filters: [] }],
    filters: [],
    hierarchies: [],
  };
}
```

- [ ] **Step 2: Update `BuilderPage.test.tsx` fixtures to v3** (mocked `getReport` responses wrap their visuals: `visuals: [...]` → `pages: [{ id: "p1", name: "Page 1", visuals: [...], filters: [] }]`, `schemaVersion: 3`; any fixture `filters` that meant "page filters" moves into the page). Add failing integration tests:

```tsx
it("switches pages: the canvas shows only the active page's visuals", async () => {
  // Fixture: two pages, page 1 holds "Revenue" (bar), page 2 holds "Costs" (bar).
  // After render: Revenue tile visible, Costs not.
  // Click the "Costs page" tab (PageBar button named after the page).
  // Now Costs visible, Revenue not.
});

it("clears selection and cross-filter when switching pages", async () => {
  // Select the page-1 visual (click its tile), assert wells pane shows.
  // Switch page; assert the wells pane shows the "Select a visual" hint.
});

it("creates the checked field's visual on the active page", async () => {
  // Switch to page 2 (empty), check a Data-pane field checkbox,
  // assert the new tile appears AND switching back to page 1 does not show it.
});

it("adds a page-scope filter from the pane onto the active page only", async () => {
  // Add filter via "Add a filter on this page", switch page,
  // assert the page scope shows "No filters on this page".
});
```

Write these concretely against the file's existing render/mocking helpers (it already renders BuilderPage with a mocked API and clicks tiles).

- [ ] **Step 3: Verify failing, then implement in `BuilderPage.tsx`.**

State additions (with the reset effect gaining `setActivePageId(null)`):

```ts
const [activePageId, setActivePageId] = useState<string | null>(null);
```

After the `definition === null` guard:

```ts
// A stale or null id degrades to the first page rather than crashing --
// pages can be deleted underneath the selection.
const activePage =
  definition.pages.find((p) => p.id === activePageId) ?? definition.pages[0];

const replacePage = (next: Page) => {
  setDefinition({
    ...definition,
    pages: definition.pages.map((p) => (p.id === next.id ? next : p)),
  });
};

/** Selection and cross-filter are page-local (PowerBI's rule too). */
const focusPage = (id: string) => {
  setActivePageId(id);
  setSelectedId(null);
  setCrossFilter(null);
};

const switchPage = (id: string) => {
  if (id !== activePage.id) focusPage(id);
};

const addPage = () => {
  if (definition.pages.length >= 20) {
    setNotice("A report can hold at most 20 pages.");
    return;
  }
  const used = new Set(definition.pages.map((p) => p.name));
  let n = 1;
  while (used.has(`Page ${n}`)) n++;
  const page: Page = {
    id: `p${crypto.randomUUID().slice(0, 8)}`,
    name: `Page ${n}`,
    visuals: [],
    filters: [],
  };
  setDefinition({ ...definition, pages: [...definition.pages, page] });
  focusPage(page.id);
};

const renamePage = (id: string, name: string) => {
  setDefinition({
    ...definition,
    pages: definition.pages.map((p) => (p.id === id ? { ...p, name } : p)),
  });
};

const duplicatePage = (id: string) => {
  const source = definition.pages.find((p) => p.id === id);
  if (!source) return;
  if (definition.pages.length >= 20) {
    setNotice("A report can hold at most 20 pages.");
    return;
  }
  const total = definition.pages.reduce((sum, p) => sum + p.visuals.length, 0);
  if (total + source.visuals.length > 50) {
    setNotice("Duplicating this page would exceed 50 visuals per report.");
    return;
  }
  const used = new Set(definition.pages.map((p) => p.name));
  let name = `Duplicate of ${source.name}`.slice(0, 100);
  for (let n = 2; used.has(name); n++) {
    name = `Duplicate of ${source.name} ${n}`.slice(0, 100);
  }
  const copy: Page = {
    id: `p${crypto.randomUUID().slice(0, 8)}`,
    name,
    // Visual ids are unique across the whole report, so a duplicate mints
    // fresh ones. Filter ids only need uniqueness within their own scope.
    visuals: source.visuals.map((v) => ({
      ...structuredClone(v),
      id: `v${crypto.randomUUID().slice(0, 8)}`,
    })),
    filters: source.filters.map((f) => ({ ...f })),
  };
  const at = definition.pages.findIndex((p) => p.id === id) + 1;
  const pages = [...definition.pages];
  pages.splice(at, 0, copy);
  setDefinition({ ...definition, pages });
  focusPage(copy.id);
};

const deletePage = (id: string) => {
  if (definition.pages.length <= 1) return;
  const remaining = definition.pages.filter((p) => p.id !== id);
  setDefinition({ ...definition, pages: remaining });
  if (activePage.id === id) focusPage(remaining[0].id);
};

const movePage = (id: string, direction: -1 | 1) => {
  const from = definition.pages.findIndex((p) => p.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= definition.pages.length) return;
  const pages = [...definition.pages];
  const [page] = pages.splice(from, 1);
  pages.splice(to, 0, page);
  setDefinition({ ...definition, pages });
};
```

Rewire every visual operation from `definition.visuals` to `activePage.visuals`:
- `selected` lookup, `replaceVisual` (via `replacePage`), `addVisual`, `toggleField`, `addFieldToSelected`, `addVisualFromSpec`, `onDragEnd`'s visual lookup, `onLayoutChange` — all read/write `activePage.visuals` and go through `replacePage`.
- `addFilterAt` gains the `"page"` scope (writes `activePage.filters` via `replacePage`); `onDragEnd` handles `PAGE_DROP_ID`.
- `exportSheets` calls the new `sheetRequestsFor({ pages: definition.pages, reportFilters: definition.filters ?? [], hierarchies, drill, crossFilter, ... })`.
- `CanvasGrid` gets `visuals={activePage.visuals}` and `pageFilters={activePage.filters ?? []}`.
- `FilterPane` gets `pageFilters={activePage.filters ?? []}` and `onChangePage={(filters) => replacePage({ ...activePage, filters })}`.
- The static page-bar block is replaced by:

```tsx
<PageBar
  pages={definition.pages}
  activeId={activePage.id}
  canEdit={canEdit}
  onSelect={switchPage}
  onAdd={addPage}
  onRename={renamePage}
  onDuplicate={duplicatePage}
  onDelete={deletePage}
  onMove={movePage}
/>
```

- [ ] **Step 4: Run the whole frontend suite and typecheck**

Run: `cd frontend && npx vitest run && npm run typecheck`
Expected: PASS / clean. Fix any remaining `definition.visuals` references the compiler names (ImportPanel/ExportPanel do not touch the shape; `ExplorerPage` keeps its v1 document).

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat: multi-page builder -- active page routing, page bar, page filter scope"
```

---

### Task 9: Docs and full verification

**Files:**
- Modify: `README.md` (reports section: pages + three filter scopes)

- [ ] **Step 1:** Add a short README subsection under the reports feature describing pages (add/rename/duplicate/reorder/delete, 20-page cap) and the three PowerBI filter scopes.
- [ ] **Step 2:** Run everything:

```bash
cd backend && python -m pytest -q
cd frontend && npx vitest run && npm run typecheck
```

Expected: all green.
- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: pages and filter scopes"
```

---

### Task 10: Unstubbed browser pass

**Files:**
- Create: scratchpad `driver/pages.mjs` (throwaway, not committed)
- Create: `docs/superpowers/manual-passes/2026-08-16-pages.md`

- [ ] **Step 1:** With backend (:8000) and frontend (:5173) running, drive Chromium against the live API (same skeleton as `driver/pbi.mjs`): sign in → open a report → add a page → rename it ("Ops") → add a visual on it via the Data-pane checkbox → add a page filter on page 2 and an all-pages filter → switch back and assert page 1 unchanged → duplicate, move, delete a page → Save → reload and assert the two pages persisted → screenshots at each step, breakpoint sweep 1440/1280/1024/768/390, assert no page errors and no failed API calls.
- [ ] **Step 2:** LOOK at the screenshots. The acceptance bar is "a PowerBI author recognises the page bar".
- [ ] **Step 3:** Write the manual-pass doc recording what was verified, what the screenshots caught, and any known compromises. Commit:

```bash
git add docs/superpowers/manual-passes/2026-08-16-pages.md
git commit -m "docs: manual pass for pages and filter scopes"
```
