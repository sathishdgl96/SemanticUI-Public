# Manual pass — PowerBI-style UI (sub-project 6)

**Date:** 2026-08-16
**Build:** `feature/foundation` at `990e640` plus the field-name and subtitle refinements
**Driver:** Chromium via Playwright against the live API, no stubs, real login

## What was verified, by looking at it

Screenshots were taken and actually inspected — this pass was about
appearance, so "the test passed" was not evidence.

**Workspace page** (`p1-workspace`): black top bar with the yellow brand
mark and identity; 48px rail with the active-Home yellow indicator;
workspace name as the title with the kind as subtitle; yellow New report;
content table with glyph/Name/Semantic view/Your role/Modified/Delete.

**Builder** (`p3-builder`): ribbon-style command bar (yellow Save, grouped
secondaries); gray canvas with a white shadowed tile; Page 1 tab with the
yellow underline; and the tri-pane — Filters (filter cards with operator +
value checkboxes), Visualizations (7-tile gallery + wells), Data (Refresh,
search, fields grouped by table with checkboxes, Σ/⬦ glyphs, type tags).

Two things the screenshots caught that the tests could not:

1. **Field rows truncated** — `CUSTOMERS.C… VARCHAR(25)` — because rows
   repeated the table prefix the group header already shows. Rows now show
   the bare field name (full ref in the tooltip and the checkbox's
   accessible name).
2. **The role stated twice** on the workspace page (subtitle + switcher).
   The subtitle now carries only the workspace kind.

## Behavior checks (live API)

| Check | Result |
|---|---|
| Rail links, identity, workspace title, table rows | All present |
| Workspaces flyout lists 3, Esc closes | Yes |
| Panes: Filters / Visualizations / Data; Page 1 bar; gallery of 7 | Yes |
| Collapse Data → strip → expand | Yes |
| Data search narrows to 1 row | Yes |
| Save / Ask / Excel / Connect live / Export all reachable | Yes |
| Horizontal overflow at 1440/1280/1024/768/390 | **None** |
| Page errors / failed API calls | **None** |

## Known compromise

At 1024px, a session resized down mid-use keeps all three panes open and the
canvas gets tight (`p6-1024`). A fresh load at that width starts Filters
collapsed, and every pane has a collapse strip. PowerBI behaves the same way
on resize; recorded here so it is a choice, not a surprise.

## Not covered

- Explorer page beyond the shell (its internals kept their existing styling).
- Dark theme (out of scope by design).
- A human aesthetic judgement — screenshots are in the session scratchpad
  (`p0`–`p6-*`); the user should look and direct any taste-level changes.
