# PowerBI-Style UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app recognisably PowerBI-like — nav rail, workspace content view, ribbon command bar, gray canvas with white tiles, and the collapsible Filters/Visualizations/Data tri-pane — without changing any backend contract or losing any behavior.

**Architecture:** Presentation and shell only. A new `AppShell` wraps the authed routes (top bar + rail + workspaces flyout); workspace selection moves to a `?workspace=` URL param; the builder's right side becomes three collapsible panes; the Data pane gains PBI checkbox semantics on top of the existing add/remove helpers. Everything else is CSS on stable markup, so the 285 existing tests keep passing except where a control genuinely moved.

**Tech Stack:** React 18 + TypeScript, react-router, TanStack Query, plain CSS custom properties. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-16-powerbi-ui-design.md`

## Global Constraints

- **Never modify or reorder `frontend/src/query/palette.ts`.** `--brand` is `#f2c811`, deliberately distinct from the palette's `#eda100`; chrome is never painted in a series color.
- Tokens exactly as the spec's table: ink `#252423`, secondary `#605e5c`, muted `#8a8886`, chrome `#f3f2f1`, surface `#ffffff`, canvas `#eaeaea`, border `#e1dfdd`, accent `#0078d4`, brand `#f2c811`, topbar `#252423`, tile shadow `0 1.6px 3.6px rgba(0,0,0,.13), 0 .3px .9px rgba(0,0,0,.1)`. Font stack starts `"Segoe UI"`.
- Focus outlines never removed; hit targets clear 24px; every `<input>`/`<select>` keeps an explicit `htmlFor`/`id`; drag is never the only path.
- The logout logic keeps `queryClient.clear()` before navigation — that was a security fix.
- Accessible names of existing controls do not change unless the control moves; then its test moves with it.
- Layout holds at 1440 / 1280 / 1024 / 768 / 390 with no horizontal overflow; the tri-pane stacks under the canvas below 1024; the existing tile-height flex fix survives.
- Run `npm run typecheck` (`tsc -b`); bare `tsc --noEmit` checks nothing.

## File Structure

**Created:** `src/shell/AppShell.tsx`, `src/shell/WorkspacesFlyout.tsx`, `src/shell/AppShell.test.tsx`, `src/reports/DataPane.tsx`, `src/reports/DataPane.test.tsx`, `src/shell/Pane.tsx` (collapsible pane frame).
**Modified:** `src/index.css` (tokens + shell + page + builder sections), `src/App.tsx`, `src/explorer/ExplorerPage.tsx` (topbar removal), `src/reports/ReportListPage.tsx` (+ its test), `src/reports/BuilderPage.tsx` (+ its test), `src/auth/LoginPage.tsx` (brand block only).

---

## Task 1: Tokens and the global reskin

**Files:** Modify `src/index.css:11-39` (token block), the `button`/`.button` rules, `body`.

- [ ] Replace the `:root` palette tokens with the spec table, keeping the density/type/transition tokens. Add `--chrome`, `--canvas`, `--brand`, `--brand-ink`, `--topbar`, `--tile-shadow`. Map the old names so existing rules keep working: `--page: #faf9f8`, `--surface: #ffffff`, `--ink: #252423`, `--ink-secondary: #605e5c`, `--ink-muted: #8a8886`, `--border: #e1dfdd`, `--accent: #0078d4`, `--grid: #e1dfdd`, `--axis: #c8c6c4`, `--accent-wash: rgba(0,120,212,.06)`, `--ink-wash: rgba(37,36,35,.04)`, `--error: #a4262c`.
- [ ] Font stack: `--font-sans: "Segoe UI", "Segoe UI Web (West European)", -apple-system, system-ui, sans-serif;`
- [ ] Buttons: default = `background: var(--brand); color: var(--brand-ink); border: 1px solid transparent; border-radius: 4px; font-weight: 600;` hover darkens to `#e0b50f`. `.secondary` = white bg, `1px solid #8a8886`, hover `var(--chrome)`. Keep disabled/focus rules.
- [ ] Login page: add a `--brand` square glyph beside the app name (markup: `<span className="brand-mark" aria-hidden="true" />` in its heading; CSS `​.brand-mark { width:14px;height:14px;background:var(--brand);display:inline-block;margin-right:8px; }`).
- [ ] Run `npx vitest run` — expect green (tokens only); `npm run typecheck`. Commit `feat: PowerBI/Fluent design tokens and button language`.

## Task 2: The app shell

**Files:** Create `src/shell/AppShell.tsx`, `src/shell/WorkspacesFlyout.tsx`, `src/shell/AppShell.test.tsx`; modify `src/App.tsx`, `src/explorer/ExplorerPage.tsx` (+ test).

**Interfaces produced:** `<AppShell>{children}</AppShell>`; flyout navigates to `/reports?workspace=<id>`.

- [ ] Failing test first (`AppShell.test.tsx`): renders brand name, nav links Home/Explore, identity from a stubbed `/api/me`, Log out posts `/auth/logout` and navigates to `/login`; Workspaces button opens a flyout listing stubbed workspaces; clicking one navigates to `/reports?workspace=w1`; Esc closes.
- [ ] `AppShell.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client";
import { useMe } from "../auth/useMe";
import WorkspacesFlyout from "./WorkspacesFlyout";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [workspacesOpen, setWorkspacesOpen] = useState(false);

  async function logout() {
    // Server session ends the moment the user asks; a network hiccup must not
    // strand another identity's cached data in this browser. Clear before
    // navigating -- this ordering was a security fix, do not reorder.
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {
      // proceed regardless
    } finally {
      queryClient.clear();
      navigate("/login");
    }
  }

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <span className="brand"><span className="brand-mark" aria-hidden="true" />SemanticUI</span>
        <span className="topbar-right">
          <span className="identity">
            {me.data ? `${me.data.snowflakeUser} @ ${me.data.snowflakeAccount}` : ""}
          </span>
          <button type="button" className="link topbar-link" onClick={logout}>Log out</button>
        </span>
      </header>
      <div className="app-body">
        <nav className="nav-rail" aria-label="Main">
          <NavLink to="/reports" className="rail-item" title="Home" end>
            <span aria-hidden="true">⌂</span><span className="rail-label">Home</span>
          </NavLink>
          <NavLink to="/explore" className="rail-item" title="Explore">
            <span aria-hidden="true">◈</span><span className="rail-label">Explore</span>
          </NavLink>
          <button type="button" className="rail-item" aria-expanded={workspacesOpen}
                  onClick={() => setWorkspacesOpen((open) => !open)} title="Workspaces">
            <span aria-hidden="true">▦</span><span className="rail-label">Workspaces</span>
          </button>
        </nav>
        {workspacesOpen && <WorkspacesFlyout onClose={() => setWorkspacesOpen(false)} />}
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
```

- [ ] `WorkspacesFlyout.tsx`: uses `useWorkspaces` + the existing create mutation; list items are buttons (name, kind glyph 🔒/▦, `myRole`, `reportCount` reports) that `navigate(\`/reports?workspace=${id}\`)` then `onClose()`; New workspace form (label `Workspace name`, explicit id via `useId`); `onKeyDown` Esc → `onClose`; `role="dialog"` `aria-label="Workspaces"`.
- [ ] `App.tsx`: wrap the three authed routes' elements as `<RequireAuth><AppShell><Page/></AppShell></RequireAuth>`.
- [ ] ExplorerPage: delete its `<header className="topbar">` identity/logout block, keep "Add to report" + hint + alert in a slim `.explorer-toolbar` row; delete the now-unused `logout` and `useMe` if unreferenced; update `ExplorerPage.test.tsx` (remove identity/logout expectations — they move to the shell test) and `a11y.test.tsx` if it queried the topbar.
- [ ] Shell CSS (`.app-shell` grid rows 40px/1fr; `.app-topbar` `--topbar` bg, white text, yellow `.brand-mark`; `.nav-rail` 48px `--chrome` column; `.rail-item` 48px square, 10px `.rail-label` under glyph, `[aria-current="page"], .active` → bold + `box-shadow: inset 3px 0 0 var(--brand)`; flyout absolute left 48px, white, `--tile-shadow`, 280px).
- [ ] Run the suite; fix the moved-control tests; typecheck; commit `feat: PowerBI-style app shell with nav rail and workspaces flyout`.

## Task 3: Workspace content page

**Files:** Modify `src/reports/ReportListPage.tsx` (+ `.test.tsx`).

- [ ] Selection from URL: `const [params, setParams] = useSearchParams();` `workspaceId = params.get("workspace")`; default to the personal workspace once workspaces load (replace the current `useState` default logic; `setWorkspaceId` becomes `setParams({ workspace: id })`). The switcher select stays in the title row (same accessible name "Workspace") so its tests hold.
- [ ] Title row: `h1` = selected workspace name (fallback "Reports"); subtitle `.ws-subtitle` = kind + "You are a/an {role} here"; Members button unchanged.
- [ ] Toolbar: New report (default/primary), Import + Explore as `.secondary`; keep the cannot-write hint and error alerts.
- [ ] Content table replacing the `ul`:

```tsx
<table className="content-table">
  <thead><tr><th aria-hidden="true"></th><th>Name</th><th>Semantic view</th><th>Your role</th><th>Modified</th><th><span className="sr-only">Actions</span></th></tr></thead>
  <tbody>
    {reports.data.reports.map((report) => (
      <tr key={report.id}>
        <td className="type-glyph" aria-hidden="true">▦</td>
        <td><Link className="report-name" to={`/reports/${report.id}`}>{report.name}</Link></td>
        <td className="mono">{report.view.database ? `${report.view.database}.${report.view.schema}.${report.view.name}` : "—"}</td>
        <td>{report.myRole}</td>
        <td>{new Date(report.updatedAt).toLocaleDateString()}</td>
        <td className="row-actions">{/* existing delete/confirm buttons verbatim */}</td>
      </tr>
    ))}
  </tbody>
</table>
```

- [ ] Add `.sr-only` utility if absent. Update `ReportListPage.test.tsx` only where the view string moved cells (queries are text-based, mostly stable); add a test: `?workspace=w1` in the URL scopes the list (`listMock` called with `"w1"`).
- [ ] CSS: `.content-table` full-width, white, 13px, hairline row borders, `tbody tr:hover` `--chrome`, th left-aligned 11px uppercase `--ink-secondary`.
- [ ] Suite + typecheck; commit `feat: PowerBI-style workspace content view with URL-scoped selection`.

## Task 4: Builder chrome — command bar, canvas, page bar, tri-pane frame

**Files:** Create `src/shell/Pane.tsx`; modify `src/reports/BuilderPage.tsx`, CSS.

- [ ] `Pane.tsx`:

```tsx
import { useState } from "react";

export default function Pane({
  title, defaultCollapsed = false, children,
}: { title: string; defaultCollapsed?: boolean; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  if (collapsed) {
    return (
      <button type="button" className="pane-strip" onClick={() => setCollapsed(false)}
              aria-expanded={false} aria-label={`Expand ${title}`}>
        <span className="pane-strip-label">{title}</span>
      </button>
    );
  }
  return (
    <section className="pane" aria-label={title}>
      <header className="pane-head">
        <h3>{title}</h3>
        <button type="button" className="pane-collapse" onClick={() => setCollapsed(true)}
                aria-expanded aria-label={`Collapse ${title}`}>»</button>
      </header>
      <div className="pane-body">{children}</div>
    </section>
  );
}
```

- [ ] BuilderPage render: header becomes `.command-bar` (name input `.report-title`, then `.cmd-group` spans with `.cmd-sep` dividers between Save/Move | Ask/Excel/Connect live | Export/Import — same buttons, same names). Canvas column gets a wrapper `.canvas-column` containing `<CanvasGrid …/>` and `<div className="page-bar"><button type="button" className="page-tab active" aria-current="page">Page 1</button></div>`. The `<aside className="builder-panes">` becomes `<aside className="builder-rail">` holding `<Pane title="Filters">…FilterPane…</Pane><Pane title="Visualizations">…picker/add/wells…</Pane><Pane title="Data">…DataPane (Task 5)…</Pane>`.
- [ ] CSS: `.command-bar` white row, hairline bottom, `.cmd-sep` 1px×20px `--border`; `.builder-body` unchanged flex; `.canvas-column` flex column (canvas grows, page bar 30px white top-hairline); `.canvas` bg `--canvas`; `.tile` white, radius 4px, `box-shadow: var(--tile-shadow)`, `.tile.selected` `outline: 1px solid var(--ink)`; `.builder-rail` = flex row of panes each `flex: 0 0 232px` (`.pane`) or `flex: 0 0 28px` (`.pane-strip`, vertical `writing-mode: vertical-rl` label); port the existing `<1024`/`<960` media rules from `.builder-panes` to `.builder-rail` (stack panes full-width under canvas). Filters pane `defaultCollapsed` at 1024–1279 via a `matchMedia` initial value.
- [ ] Builder tests: queries are by role+name and survive; fix any `within(...)` scoping that assumed one aside. Add a test: collapsing "Data" hides the field search, expanding restores it.
- [ ] Suite + typecheck; commit `feat: builder command bar, PBI canvas, page bar, collapsible tri-pane`.

## Task 5: The Data pane

**Files:** Create `src/reports/DataPane.tsx` + test; modify BuilderPage (replace the fields section and move HierarchyPane in).

**Interfaces:** `<DataPane dimensions metrics hierarchies selected canEdit onToggleField(ref,kind,checked) onAdd(ref,kind) hierarchyRow(h) refresh …/>` — concretely:

```tsx
interface DataPaneProps {
  dimensions: FieldInfo[];
  metrics: FieldInfo[];
  selected: Visual | null;
  canEdit: boolean;
  onToggleField: (ref: string, kind: FieldKind, nextChecked: boolean) => void;
  renderFieldRow: (field: FieldInfo, kind: FieldKind) => React.ReactNode; // wraps existing draggable row
  refreshSlot: React.ReactNode;   // the existing Refresh fields button
  hierarchySlot: React.ReactNode; // HierarchyPane + placeable rows
}
```

DataPane groups `[...dimensions, ...metrics]` by `field.table` into collapsible `<details className="data-table" open>`-style sections (real button+state, not `<details>`, for styling), renders a search `<input>` (label "Search fields", explicit id) filtering by substring, and each row as: checkbox (`aria-label` = ref, `checked` = ref present in any well of `selected`, `disabled` = `!canEdit`) + the existing draggable row content.

- [ ] Failing tests: search narrows rows; checkbox reflects membership; checking calls `onToggleField(ref, kind, true)`; unchecking calls with `false`; tables collapse.
- [ ] BuilderPage: `onToggleField` = checked→ if no visual selected `addVisual("bar")` then `addFieldToSelected(ref, kind)` (order: create, select, add — `addVisual` already selects); unchecked→ `replaceVisual` stripping `ref` from every well. Move `HierarchyPane` + `BuilderHierarchyRow` group into `hierarchySlot`. Delete the old Fields section markup.
- [ ] Update BuilderPage tests that used the old Fields grouping if any query breaks; add: "checking a field with no visual selected creates a visual carrying it".
- [ ] CSS: `.data-table-head` chevron rows, `.data-row` 24px with checkbox + glyph + name, hover `--chrome`.
- [ ] Suite + typecheck; commit `feat: PBI Data pane with search, table groups and checkbox semantics`.

## Task 6: Filters/Visualizations polish, full verification, browser pass, docs

- [ ] CSS only: `.filter-scope h4` → "Filters on this page" wording change in FilterPane (update its test string), filter cards (`.filter-editor` white card, summary as card header); `.visual-picker` as 4-per-row 30px tile grid, selected = `2px solid var(--accent)`; wells: label above bordered 28px drop row, hint text "Add data fields here" (update the well-hint string + any test asserting the old hint).
- [ ] Full suites: `npx vitest run`, `npm run typecheck`, `npx oxlint`; backend untouched but run `pytest -q` once to prove it.
- [ ] Unstubbed browser pass, real login: screenshot reports page, flyout, builder at 1440/1280/1024/768/390; assert no horizontal overflow; assert every command still reachable (Save, Move, Ask, Excel, Connect live, Export, Import, Members, New workspace, delete report). Record in `docs/superpowers/manual-passes/2026-08-16-powerbi-ui.md` including what was NOT covered.
- [ ] README: replace the explorer/reports UI descriptions' outdated bits with the shell/tri-pane reality.
- [ ] Commit `feat: PBI filter cards and visual gallery; docs and browser pass`.

## Done When

- The app opens to a rail + top bar shell; workspaces are reachable from the rail; the report list is a workspace content table scoped by URL.
- The builder shows ribbon bar, gray canvas with white shadowed tiles, Page 1 bar, and three collapsible panes in PBI order.
- Checking a field with nothing selected creates a visual, PBI-style; unchecking removes it.
- All suites green, typecheck clean, no horizontal overflow at any of the five widths, and every pre-existing command reachable.
