# Manual pass — Format pane, sort/Top N, ad-hoc aggregation

**Date:** 2026-08-16
**Build:** `feature/foundation` at `656f9e6`
**Driver:** Chromium via Playwright against the live API, no stubs, real login
**Backend:** a freshly-started instance on :8001 with `--reload`

## Verified against the live account

| Check | Result |
|---|---|
| Raw FACT columns appear in the Data pane beside the view's metrics | Yes — 28 rows |
| A fact in a measure well gets an aggregation picker; a metric does not | Yes |
| Default aggregation is Sum | Yes |
| Switching Sum → Average re-queries with no tile error | Yes |
| Format tab sections | Title, Legend, Data, Display, Sort and rows |
| Data labels render on the marks | Yes — visible on the bar |
| Sort by a measure + Top 5 applies with no error | Yes |
| Page errors / failed API calls | **None** |

## What running it taught us that the spike had not

The spike asked "can a fact be aggregated?" and got yes. It asked with
`CUSTOMERS.CUSTOMER_NAME` and `CUSTOMERS.ACCOUNT_BALANCE` — the same table —
and that turned out to be load-bearing. The real rule is:

> All expressions referenced in the query must come from the same entity when
> both FACTS and DIMENSIONS are specified.

A raw fact carries no join path; only the model's METRICS do. So an ad-hoc
aggregation can only be grouped by dimensions of its own table. The API now
refuses the cross-entity combination itself, with a message naming the table
to group by — Snowflake's own message names no field, so passing it through
would leave the user guessing.

The integration fixture that "passed" was quietly picking `dimensions[0]`,
which happened to share a table with `facts[0]`. It now derives the dimension
from the fact's table deliberately, and a second test asserts the
cross-entity case is refused before Snowflake ever sees it.

## A bug the test suites could not see

The fact list reached the Visualizations pane — the aggregation picker
appeared and defaulted to Sum, which looked like success — but never reached
the canvas. Every raw fact was therefore sent as a governed metric, and the
query came back `400 Unknown metric: LINEITEMS.EXTENDED_PRICE`.

Both component suites were green on either side of the gap: `VisualWells`
was handed the list in its own test, and `useVisualQuery` split measures
correctly in its own test. Nothing asserted that `BuilderPage` connected
them. There is now a test that does.

## The stale-server trap, again

The instance on :8001 had been started without `--reload`, so it kept serving
code from before the aggregation work while the frontend sent the new shape.
The first symptom was `orderBy field not selected`, which reads like a
frontend bug and is not.

This is the second time in two days. The check is cheap: confirm the server
actually restarted (and bound) before believing a failure it reports.

## Known limits

- Ad-hoc aggregation is confined to one entity per visual, as above. Mixing a
  view metric with an ad-hoc aggregation in the same visual is also refused —
  they are measured at different grains.
- Text box and image visuals are still not built.
- The visual header "..." menu (focus mode, export this visual's data) is
  still not built; sort now lives in the Format pane instead.
