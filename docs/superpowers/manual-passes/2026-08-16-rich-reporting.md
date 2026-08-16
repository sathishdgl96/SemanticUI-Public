# Manual pass — rich reporting (pages, gallery, filters, responsive)

**Date:** 2026-08-16
**Build:** `feature/foundation` at `06138ac`
**Driver:** Chromium via Playwright against the live API, no stubs, real login
**Backend:** a freshly-started instance on :8001 (see "A trap worth recording")

## What was verified

### Pages and filter scopes

| Check | Result |
|---|---|
| Page tabs render; Add page appends "Page 2" | Yes |
| Rename / duplicate / move / delete reachable from the tab menu | Yes |
| Switching pages swaps the canvas and clears the selection | Yes |
| Three filter scopes present, narrowest first | Yes — visual, page, all pages |
| A page filter stays on its own page | Yes |

### The gallery

16 tiles, up from 7: column, bar, line, area, line-and-column, pie, donut,
treemap, funnel, gauge, scatter, table, matrix, card, multi-row card, slicer.
A slicer was added on the canvas and loaded 1000 real values from the view.

### Filter operators

The operator menu on a text field offered exactly:

> is | is not | contains | does not contain | starts with | ends with |
> is blank | is not blank

`contains` and `is not blank` both ran against the live view with no tile
errors and no failed API calls. `is blank` correctly shows no value box and
explains why.

### Cross-filtering

Clicking a bar on one chart filtered the other visual on the page and raised
the chip: *"Filtered by CUSTOMERS.CUSTOMER_NAME = Customer#000032390 —
Clear cross-filter"*. The source visual is not filtered by its own selection.

### Responsive

| Viewport | Result |
|---|---|
| 1440 / 1600 desktop | No horizontal overflow |
| iPad Mini landscape | No horizontal overflow |
| Pixel 7 (412px) | No overflow; rail is a horizontal bottom bar; tile is full width (396px) |
| Save / Ask / Excel reachable on the phone | Yes |

Zero page errors and zero failed API calls on every pass.

## What looking at the screenshots caught that the tests did not

1. **A blank builder.** Against a server still running pre-migration code,
   `definition.pages` was undefined, the read threw, and React unmounted the
   whole page. Definitions are now normalised on the way in, so an older
   document degrades to one page rather than a white screen.
2. **The canvas painting over the page bar and pane headers on a phone.**
   `.canvas-column` kept `flex: 1` against a parent with no definite height,
   collapsed to nothing, and its tiles overlapped everything below. The fix
   has to sit at the END of the stylesheet — the rule it beats is declared
   after the existing breakpoint block.
3. **A tooltip clipped by its tile**, reading "ustomer#000031016" — which
   looks like bad data rather than a bad tooltip.
4. **"is 0 values"** on a filter with nothing ticked, which reads as broken
   rather than unfinished.

## Snowflake findings

`LIKE ... ESCAPE` is a **syntax error inside SEMANTIC_VIEW()** — the grammar
there is narrower than the plain WHERE it resembles:

> syntax error line 4 at position 43 unexpected 'ESCAPE'

Substring matching therefore uses `CONTAINS` / `STARTSWITH` / `ENDSWITH`,
which is the better answer anyway: they have no wildcard semantics, so a user
searching for "50%" gets rows containing "50%" and there is nothing to escape.
An integration test asserts a literal "%" does not match every row.

Comparison operators, the blank tests and `NOT BETWEEN` all ran unmodified
against the real account.

## A trap worth recording

A backend process started outside this session held port 8000 and could not
be inspected or killed from here. A restarted server silently failed to bind
(`errno 10048`) and the browser pass kept hitting the OLD build, which
reported the old four filter operators and 422'd every new one. The symptom
looked like a frontend bug and was not.

Two lessons: check that a restarted server actually bound before trusting a
pass against it, and the Vite dev proxy target is now overridable
(`SEMANTICUI_API_TARGET`) precisely so a pass can be run against a second
backend when the first port is occupied.

## Not covered

- The matrix, multi-row card, treemap, funnel and gauge were verified by unit
  tests and appear in the gallery, but were not each individually rendered
  against live data in this pass.
- Excel export of a multi-page report (page-prefixed sheet titles) is unit
  tested but was not downloaded and opened here.
- Ad-hoc aggregation (Sum/Avg/Count on any column) is still not built — it
  was approved for sub-project 7d.
