# Manual pass — the explorer, reshaped around Looker

**Date:** 2026-08-16
**Driven against:** the live API and the live Snowflake account. No stubs.
**View:** `SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS`

## What prompted it

Three things, from the same message: the field picker was not on the left,
there was one chart type, and the row limit could not be raised.

The picker being third from the left was the real complaint. The explorer had
four columns — Views, Selection, Fields, Canvas — which spent 744px on chrome
before showing a number, and put the thing you interact with most in the
middle. Looker has two: a field picker against the left edge, and one stack of
sections to its right.

## Result

| # | Check | Result |
|---|---|---|
| 1 | Two columns, not four | `.left@49 w248`, `.main@297 w1143`; `.selection` and `.middle` gone from this page |
| 2 | Field picker is leftmost | picker x=57, selection strip x=313 |
| 3 | Sections stacked to its right | `▾Filters`, `▾Visualization`, `▾Data` |
| 4 | The gallery is offered, not one auto-chart | 14 of 15 types available for a one-dimension, one-measure selection |
| 5 | Each type actually draws | Pie, Line, Bar, Treemap, Card, Matrix, Table all rendered; 0 page errors |
| 6 | Row limit above the old ceiling | typed 2500, query ran, Data header reads it back |
| 7 | Sections fold | Data body removed from the DOM when collapsed; its row-limit control stays in the header |
| 8 | Sidebar sections are labelled | VIEWS / SAVED EXPLORES / FIELDS visible at every width |
| 9 | Horizontal overflow at 1280 / 768 / 390 | 0px at all three |
| 10 | Failed API calls | none |

Screenshots: `L1-shell.png`, `L2-run.png`, `L3-<type>.png`, `L4-folded.png`,
`L5-{1280,768,390}.png`.

## What looking at the screenshots caught

**The wells stacked instead of running across.** `.explore-selected
.well-panel { display: flex }` looked sufficient and was not: the base
`.well-panel` rule sets `flex-direction: column`, and overriding `display`
alone leaves the direction in force. The three wells stacked down the page and
the Run button stretched full width. Fixed by overriding `flex-direction`,
along with the top border and margin that had separated the wells from a pane
that no longer exists.

**The sidebar lost its section boundaries.** `.pane-heading` was deliberately
hidden above 960px, on the reasoning that side-by-side columns give their own
context. True when they were columns — but views, saved explores and fields
now stack in one sidebar, where position no longer says which is which. The
headings are shown in the explorer's sidebar at every width.

## Behaviour that changed, deliberately

- **"Add to report" hands over the visual on screen.** It used to build a bar
  chart whatever you were looking at. A lone dimension and a lone measure had
  to leave the button disabled, because a bar needs both; they are now a table
  and a card respectively, and both are perfectly good reports. Two tests that
  asserted the old refusal were replaced.
- **`QueryPanel` and `chooseChart` were deleted.** The explorer draws with the
  report canvas's renderer now, which is why the gallery works at all. Keeping
  a second chart path for one caller would have meant two implementations of
  the same picture, drifting.

## Not covered

- The visual's **format options** (titles, legends, stacking, data labels) are
  not exposed in the explorer — a chart there uses defaults. The Format pane
  exists on the report side, and the hand-off carries the visual, so the route
  to formatting is "add to report".
- The row limit is capped at **10 000**, which is the server's `row_cap` and
  the saved-explore schema's `MAX_ROW_LIMIT`. The input clamps rather than
  letting a larger number be typed and silently reduced.
