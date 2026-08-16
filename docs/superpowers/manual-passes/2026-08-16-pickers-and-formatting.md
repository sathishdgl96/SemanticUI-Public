# Manual pass — value picker, format controls, and pane chrome

**Date:** 2026-08-16
**Driven against:** the live API and the live Snowflake account. No stubs.
**View:** `SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS`

## What prompted it

Four requests: a filter listing a thousand values took over the pane; charts
had almost nothing to customise; the filter scopes each carried a sentence of
explanation nobody needed twice; and "Remove filter" shouted louder than the
filters.

## Result

| # | Check | Result |
|---|---|---|
| 1 | A picker shows one screenful | 10 checkboxes, not 1000 |
| 2 | It says there are more | "More values match. Keep typing to narrow the list." |
| 3 | Search reaches past the first page | `customer#000149` → `Customer#000149085 …` out of 150 000 |
| 4 | Search is case-insensitive | a lower-case needle matched mixed-case data |
| 5 | Search runs on the server | predicate inside `SEMANTIC_VIEW(...)`, value bound |
| 6 | A ticked value survives a search that hides it | chip stayed; "No values match "zzzz-nothing"" shown |
| 7 | Format pane sections | Title, Legend, Values, Axes, Display, Sort and rows |
| 8 | Independent text sizes | 4 size controls: title, legend, labels, axes |
| 9 | Legend title and axis titles | all three accepted and drawn |
| 10 | Chart survives every change | 0 tile errors, chart still drawn |
| 11 | Filter scopes are short | "This page" / "All pages", body "None" |
| 12 | The explanation is on request | no `role=note` until the ⓘ is clicked, correct text after |
| 13 | Page errors / failed API calls | none / none |

Screenshots: `V1-picker.png`, `V2-search.png`, `V3-chips.png`, `V4-scopes.png`,
`V5-format.png`.

## What looking at the screenshots caught

**Data labels overprinted each other.** At 16px on a narrow tile five labels
rendered as `30,18929,94930,14229,75229,968`. Every assertion passed — the
labels were present and correctly sized. Fixed with `labelLayout:
{ hideOverlap: true }`: a label that will not fit is dropped, because three
legible numbers say more than five illegible ones.

**"Show legend" was ticked and no legend appeared.** The renderer has always
suppressed a legend of one entry, on the grounds that it only repeats the
title — reasonable, but silently contradicting a checkbox is not. The Legend
section now says so: "One series, so no legend is drawn. Add a measure, or
split by a field, to give it something to tell apart."

**The filter card's summary drifted to the middle.** Replacing the "Remove
filter" text button with a 24px icon left the summary button free to fill the
row, and a `<button>` centres its content — `text-align: left` does not reach
flex children. Needed an explicit `justify-content: flex-start`.

## Behaviour that changed, deliberately

- **`contains`, `notContains`, `startsWith` and `endsWith` are now
  case-insensitive** — `CONTAINS(UPPER(col), ?)`, with the bound value
  upper-cased to match. `CONTAINS(segment, 'mach')` previously found nothing
  in a column of `MACHINERY`. Every comparable product matches text this way,
  and search could not work otherwise. Verified against the real account;
  `test_filter_operators_it.py` still passes.
- **`format` (number format) applies to every visual type**, not just cards,
  and drives axis labels as well as data labels. Two renderings of the same
  measure on one chart would be a reason to distrust both.
- **The values endpoint defaults to 10, not 1000**, and takes `search` and
  `limit`. `truncated` now means "more match", which is a prompt rather than
  an apology.

## Not covered

- **Pie, treemap, funnel, gauge and scatter** read the shared format options
  through their own renderers, which this pass did not exercise one by one —
  only the categorical path (bar/line/area/combo) was driven end to end.
- **The legend title is drawn as a second ECharts `title`** anchored to the
  legend's edge, because ECharts has no legend-title component. It looks right
  bottom and top; left and right positions were not inspected.
