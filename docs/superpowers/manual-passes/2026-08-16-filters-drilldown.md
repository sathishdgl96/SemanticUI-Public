# Manual pass — filters, hierarchies, drill-down (sub-project 2b)

**Date:** 2026-08-16
**Build:** `feature/foundation` at `e022513`
**Account:** `xriieim-eh01350`, model `SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS`
**Driver:** Chromium via Playwright, 1440×900

## What kind of pass this was

**Unstubbed.** The browser talked to the real backend on `localhost:8000`,
which talked to real Snowflake. There is no `page.route` call anywhere in the
driver.

That distinction is the point. The 2a "New report" bug survived 266 green
tests and 15 reviews because every earlier pass stubbed `/api/*`: the frontend
was only ever checked against a body the *stub* accepted, never against one
the real server accepts. This pass found a bug of exactly that shape within
minutes — see below.

## What it found

**A filter you had added but not yet finished 422'd every tile on the report,
and made the report unsavable.**

Adding a filter from the field picker creates it with `values: []`, since no
value has been ticked. The request model required at least one value, so the
moment a filter row appeared, every `POST /api/query/semantic` came back 422
and every tile failed. Switching an operator to `between` seeded empty
endpoints and did the same thing.

Fixed in `e022513`: an empty selection means "not filtering yet", not "match
nothing". Both sides of the wire now accept it in the document and skip it
when building SQL.

Every automated test missed it — 208 frontend, 264 backend — because they all
stub the endpoint that was doing the rejecting.

## Steps and results

| # | Step | Result |
|---|---|---|
| 1 | Sign in with real Snowflake credentials | Signed in |
| 2 | New report, bind to the real semantic view | 22 fields listed |
| 3 | Add a bar visual, place a dimension and a metric by clicking | Chart rendered |
| 4 | Add a report-scope filter | 22 fields offered; 1000 distinct values loaded from the account |
| 4b | Add a **second** filter and leave it unfinished | Tiles keep rendering; **no failed API calls** |
| 5 | Save, reload | Both filters persisted |
| 6 | Define a hierarchy, add two levels | Appears in Fields as a placeable row |
| 7 | Export | Contains `filters` and `hierarchies`; **no** `hierarchyId`, **no** `sourceVisualId` |
| 8 | Resize to 1440 / 1280 / 1024 / 768 / 390px | No horizontal overflow at any width |

Final state: **no page errors, no failed API calls.**

## Two driver bugs worth recording

Both initially looked like product bugs and were not.

The login page's authenticator `<select>` is itself labelled
"Authenticator … Password", so `getByLabel(/password/i)` matched two
elements. The password field has to be targeted by role.

The export panel is a readOnly `<textarea>`, whose content lives in `.value`
— `innerText()` returns `""`. The first run therefore reported "export
mentions filters: false", which read as filters being dropped from the export.
They were not; `inputValue()` shows a 938-byte document containing both new
collections.

## What this pass did NOT cover

Stated plainly rather than implied by omission.

- **Clicking a mark to drill.** The hierarchy was defined and shown as
  placeable, but not placed on an axis and drilled through in the browser.
  Drill mechanics are covered by `VisualTile.test.tsx` (advance, breadcrumb,
  drill up, stop at last level, Backspace) and the two-level drill *queries*
  are covered by `test_a_two_level_drill_narrows_at_each_step` against the
  real account — but the click-through itself was not driven here.
- **Cross-filtering between two tiles in the browser.** Covered by unit tests
  at both the tile and builder level, not by this pass.
- **Keyboard drill (Enter / Backspace) in a real browser.** Covered by
  `AutoChart.test.tsx` and `VisualTile.test.tsx` only.
- **Importing a v1 document through the UI.** The migration is covered by
  `test_importing_a_v1_document_still_works` and `test_report_migrate.py`.

## Screenshots

`f1-signed-in`, `f2-bound`, `f3-visual`, `f4-report-filter`,
`f4b-unfinished-filter`, `f5-after-reload`, `f6-hierarchy`, `f7-export`,
`f8-{1440,1280,1024,768,390}` — written to the session scratchpad, not
committed.
