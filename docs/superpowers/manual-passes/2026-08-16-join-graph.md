# Manual pass — join graph in the explorer

**Date:** 2026-08-16
**Driven against:** the live API and the live Snowflake account. No stubs, no
`page.route`.
**View:** `SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS`

## What prompted it

Adding a second dimension in the explorer could fail with

> Invalid dimension specified: The dimension entity 'SUPPLIER' is not directly
> related to the base dimension entity 'PART'.

Snowflake's message names entities, never fields, and arrives after a round
trip. The findings behind the fix are in
`docs/superpowers/specs/2026-08-16-join-graph-findings.md`.

## Result

| # | Check | Result |
|---|---|---|
| 1 | `DESCRIBE` reaches the client with join endpoints | `CUSTOMERS->NATION, LINEITEMS->ORDERS, LINEITEMS->PART, LINEITEMS->SUPPLIER, NATION->REGION, ORDERS->CUSTOMERS` |
| 2 | `PART.BRAND` + `SUPPLIER.SUPPLIER_NAME` — previously a 400 | runs; columns `BRAND | SUPPLIER_NAME`; 10 000 rows (row cap) |
| 3 | The bridge is disclosed | "Joined through LINEITEMS. These fields have no direct relationship, so the rows are the combinations that actually occur there." |
| 4 | No error is shown for it | `[role=alert]` count 0 |
| 5 | With `CUSTOMERS.CUSTOMER_COUNT` selected, unreachable fields go dead | `PART.BRAND` blocked, `ORDERS.ORDER_DATE` blocked |
| 6 | Reachable fields stay offered | `NATION.NATION_NAME` offered, `REGION.REGION_NAME` offered |
| 7 | The reason is stated once, not per row | 1 note: "Not available with CUSTOMERS.CUSTOMER_COUNT selected — it is measured per CUSTOMERS." |
| 8 | A legal combination still runs | `NATION_NAME | CUSTOMER_COUNT`, 25 rows, bar chart renders |
| 9 | Page errors | none |
| 10 | Failed API calls | none |

Screenshots: `j1-bridged.png`, `j2-gated.png`, `j3-legal.png`.

## What looking at the screenshots caught

The first run passed every assertion above and still looked wrong. The reason
a field was unavailable was rendered **under each blocked row** — twelve
identical three-line explanations, which tripled the height of the dimension
list and buried the two fields that were still available. Nothing in the test
could see that; the text was present and correctly associated, which is all an
assertion can ask.

Fixed by rendering one note per distinct reason at the head of the group, with
every blocked row pointing at it via `aria-describedby`. Same information, same
accessibility, a twelfth of the space.

## Not covered

- **The report builder's Data pane does not grey out fields.** A report visual
  that names an unreachable combination now gets the clear server-side message
  instead of Snowflake's, which is an improvement, but it is not the
  prevention the explorer has. The rule lives in `frontend/src/explorer/joins.ts`
  and would need wiring into the builder's field list.
- **Views whose `DESCRIBE` predates this change** send relationship names with
  no endpoints. Both the server planner and the client picker stand down
  entirely in that case rather than guess — covered by unit tests on both
  sides, not exercised here.
