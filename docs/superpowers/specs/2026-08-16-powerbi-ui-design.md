# PowerBI-Style UI — Design

**Date:** 2026-08-16
**Status:** Approved
**Sub-project:** 6 — a UI overhaul of everything shipped in 1–5

## Why

The original brief asked for "a PowerBI kind of reporting capability" and
"UI must be similar to PowerBI". Sub-projects 1–5 delivered the capability
function-first; the chrome stayed generic. The user's verdict is accurate:
the report list, workspace UI and builder look basic, not like PowerBI.

This sub-project changes **presentation and shell structure only**. No
backend contract changes, no feature removals, and every existing behavior
stays reachable. The 285 frontend tests keep passing except where a control
genuinely moved, in which case the test moves with it.

## What "looks like PowerBI" means here, concretely

Not the logo, not the name, not a claim to be Microsoft's product — the
recognisable structure and visual language:

1. A **left nav rail** with a **workspaces flyout**.
2. A **workspace content page**: title, role, toolbar, and a content table.
3. The **builder**: ribbon-style command bar on top; gray canvas with white,
   shadowed tiles; a page bar at the bottom; and the **tri-pane** on the
   right — Filters, Visualizations, Data — each collapsible.
4. The **Fluent visual language**: Segoe UI, `#252423` ink on light-gray
   chrome, dense 13px type, subtle borders, and PowerBI's signature yellow
   used exactly where PowerBI uses it — brand mark, primary action,
   active-nav indicator.

## Design Tokens (replacing the current neutral set)

| Token | Value | Used for |
|---|---|---|
| `--font-sans` | `"Segoe UI", "Segoe UI Web (West European)", -apple-system, system-ui, sans-serif` | everything |
| `--ink` | `#252423` | primary text |
| `--ink-secondary` | `#605e5c` | secondary text |
| `--ink-muted` | `#8a8886` | hints, disabled |
| `--chrome` | `#f3f2f1` | rail, pane headers, hovers |
| `--surface` | `#ffffff` | panes, tiles, tables |
| `--canvas` | `#eaeaea` | the report canvas background |
| `--border` | `#e1dfdd` | all hairlines |
| `--accent` | `#0078d4` | links, focus, selected states |
| `--brand` | `#f2c811` | brand mark, primary buttons, active-nav bar |
| `--brand-ink` | `#252423` | text on brand yellow |
| `--topbar` | `#252423` | the app top bar |
| `--tile-shadow` | `0 1.6px 3.6px rgba(0,0,0,.13), 0 .3px .9px rgba(0,0,0,.1)` | tiles, flyouts |

Buttons: default (primary) = yellow `--brand` with `--brand-ink` text;
`.secondary` = white with `#8a8886` border, hover `--chrome`; `.link`
unchanged in behavior, colored `--accent`. Focus outlines are never removed.

`src/query/palette.ts` is not touched. Chrome is never painted in a series
color; `--brand` (#f2c811) is deliberately distinct from the palette's
#eda100.

## The Shell (`src/shell/AppShell.tsx`)

Wraps every authenticated route.

- **Top bar** (40px, `--topbar`): yellow brand square + "SemanticUI" at
  left; at right the identity (`USER @ ACCOUNT`, from `useMe`) and
  **Log out** — moved here from ExplorerPage, keeping its exact logic
  including `queryClient.clear()` before navigating, which was a security
  fix and must not be lost.
- **Nav rail** (48px, `--chrome`): icon buttons stacked — Home (→
  `/reports`), Explore (→ `/explore`), Workspaces (opens the flyout). The
  active route gets bold ink and a 3px yellow left bar. Each button carries
  a visible-on-hover tooltip via `title` and a proper `aria-label`.
- **Workspaces flyout** (280px panel over the content, `--tile-shadow`):
  every workspace from `useWorkspaces` with name, kind glyph, the caller's
  role, and report count; clicking one navigates to
  `/reports?workspace=<id>`; a **New workspace** form at the bottom (reusing
  the existing create mutation and invalidation). Esc and outside-click
  close it.

ExplorerPage loses its private topbar (identity/logout now in the shell) and
keeps "Add to report" in its own toolbar.

## Workspace Content Page (ReportListPage restyled)

Workspace selection moves from component state to the **`?workspace=` URL
param**, so the rail flyout and the page share one source of truth and a
workspace view becomes linkable. Default remains the personal workspace once
the list loads.

Layout, top to bottom:

1. **Title row**: workspace name as `h1`, kind + "You are a/an {role} here"
   as the subtitle; **Members (n)** button for shared workspaces (opens the
   existing MembersPanel).
2. **Toolbar**: New report (primary yellow), Import, Explore. Disabled with
   the existing reason line when the caller cannot write here.
3. **Content table** (white, hairline rows, hover `--chrome`): columns
   Type-glyph · Name (link) · Semantic view · Your role · Modified ·
   row actions (Delete with the existing confirm flow). Empty state keeps
   its current wording.

The `WorkspaceSwitcher` select survives as the compact fallback inside the
title row (relabelled visually, same accessible name "Workspace"), because
drag/flyout must never be the only path and its tests stay valid.

## The Builder

### Command bar

One ribbon-style row (white, bottom hairline): the report-name input styled
as the PBI title field at left, then grouped buttons with thin separators —
**Save** (primary) | **Move** | **Ask · Excel · Connect live** | **Export ·
Import**. All existing accessible names unchanged. The read-only hint and
error alerts render directly beneath the bar as today.

### Canvas

`--canvas` background. Tiles: white, 4px radius, `--tile-shadow`, 12px
semibold header in `--ink`; selection = 1px `--ink` border (react-grid-layout
handles unchanged). The drill breadcrumb and per-tile errors keep their
places.

**Page bar** at the bottom of the canvas column: a single "Page 1" tab,
active-styled. It is honest — the report has exactly one page — and becomes
the natural home for multi-page later. No dead "+" button.

### The tri-pane

Right side becomes three side-by-side panes in PBI order —
**Filters · Visualizations · Data** — each 232px, white, with a PBI-style
header (11px uppercase title + collapse chevron). Collapsing shrinks a pane
to a 28px strip showing a vertical label; clicking the strip reopens it.
Collapse state is per-pane React state (ephemeral, like PBI).

- **Filters pane**: the existing FilterPane, restyled as PBI filter cards —
  scope headings become "Filters on this page" / "Filters on this visual",
  each filter a bordered card with the summary line as its header and the
  editor below. All existing labels and behavior unchanged.
- **Visualizations pane**: the existing icon grid styled as the PBI tile
  grid (28px tiles, selected = accent border), then **Add visual**, then the
  wells restyled as PBI field wells: label above a bordered drop row,
  "Add data fields here" as the empty hint, chips as PBI field pills.
- **Data pane** (renamed from Fields, with a "Refresh" affordance kept):
  - A **search box** filtering fields by substring (client-side).
  - Fields **grouped by table**, collapsible per table with a chevron.
  - Each field row: **checkbox** + kind glyph (Σ / ⬦) + name; checked iff
    the ref is in any well of the selected visual. Checking adds it via the
    existing default-well logic — and if **no visual is selected, checking a
    field creates a new bar visual first**, exactly PBI's behavior, reusing
    `addVisual`. Unchecking removes the ref from whichever well holds it.
    Rows remain draggable; the checkbox is a real `<input>` with the field
    ref as its accessible name.
  - **Hierarchies** as a collapsible section at the bottom of this pane
    (HierarchyPane moves in, unchanged internally), with the placeable
    hierarchy rows beside the fields where PBI would show them.

### Responsive

≥1280: all three panes open. 1024–1279: panes default to two open (Filters
collapsed). <1024: the tri-pane stacks under the canvas full-width (the
existing stacked behavior, updated selectors). 390px must show no horizontal
overflow anywhere. The existing tile-height flex fix is preserved.

## Login page

Light touch only: brand block + Segoe styling so the first screen matches.
No structural change.

## What is deliberately not done

Multi-page reports; undo/redo; a fake ribbon with empty tabs (one honest
command bar instead); dark theme; renaming the product; copying Microsoft
assets, icons, or trademarked imagery — glyphs stay text/emoji or simple
inline SVG drawn here.

## Testing

- Existing suites stay green; tests are updated only where a control moved
  (identity/logout → shell; workspace selection → URL param).
- New tests: shell renders nav + identity and logs out via the moved logic;
  workspaces flyout lists workspaces and navigates; Data pane search
  filters; checkbox checks reflect the selected visual's wells; checking
  with no visual selected creates one; unchecking removes the field; pane
  collapse hides content and restores it.
- Unstubbed browser pass with screenshots at 1440/1280/1024/768/390,
  checking overflow and that every command from before is still reachable.
