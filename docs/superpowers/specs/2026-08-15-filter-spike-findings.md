# Filter Spike — Findings

**Date:** 2026-08-15
**Account:** `xriieim-eh01350`
**Model probed:** `SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS`
**Test:** `backend/tests/integration/test_filter_spike_it.py` (5 passed)

## Verdict

**The design assumption holds in full. Implementation proceeds unchanged.**

All four questions came back the way
`docs/superpowers/specs/2026-08-15-filters-hierarchies-drilldown-design.md`
assumed, including the one that would have forced a redesign. Neither ranked
fallback is needed, and no sign-off is outstanding.

## Q1 — `WHERE` is accepted *inside* `SEMANTIC_VIEW(...)`

Accepted, 1 row. The clause sits between `METRICS` and the closing paren:

```sql
SELECT * FROM SEMANTIC_VIEW(
  "SEMANTIC_DEMO"."TPCH"."TPCH_SALES_ANALYTICS"
  DIMENSIONS "CUSTOMERS"."CUSTOMER_NAME"
  METRICS "CUSTOMERS"."CUSTOMER_COUNT"
  WHERE "CUSTOMERS"."CUSTOMER_NAME" = 'Customer#000000157'
) LIMIT 10
```

The fallback path — `WHERE` applied *after* the call, filtering the result
rather than the aggregation — was never reached and is not needed.

Fields are referenced the same way in `WHERE` as in `DIMENSIONS`:
fully qualified and double-quoted, `"TABLE"."FIELD"`.

## Q2 — bind parameters work, in both paramstyles

| paramstyle | placeholder | result |
|---|---|---|
| `qmark` | `?` | ACCEPTED, 1 row |
| `pyformat` | `%s` | ACCEPTED, 1 row |

**Implementation uses `qmark`.** Both work, but they are not equivalent:
`pyformat` is *client-side* binding — the connector escapes the value and
interpolates it into the statement before sending. `qmark` is server-side:
the value travels separately and is never part of the SQL text. Since the
whole point of the filter design is that a value is never SQL, the weaker
of two working options would be a strange choice.

`PLACEHOLDER = "?"` in `app/semantic/predicates.py` stands as planned, and
`snowflake.connector.connect(..., paramstyle="qmark")` is required on every
connection in `app/snowflake/connect.py`.

### Trap worth recording

The connector's default paramstyle is `pyformat`. On such a connection a `?`
is not a placeholder at all, and `cursor.execute(sql, params)` dies inside
the connector with:

```
TypeError: not all arguments converted during string formatting
```

That is a **client-side Python error, raised before Snowflake ever sees the
statement** — it looks exactly like Snowflake rejecting the syntax. The first
run of this spike hit it on Q3/Q4 and briefly read as "assumption broken".
If a filtered query ever fails this way, the connection was opened without
`paramstyle="qmark"`; it is not a Snowflake problem.

## Q3 — a filter may reference a dimension the query does not select

**Accepted, and it stays aggregated.** This is the question that decided the
feature's shape.

```sql
SELECT * FROM SEMANTIC_VIEW(
  "SEMANTIC_DEMO"."TPCH"."TPCH_SALES_ANALYTICS"
  METRICS "CUSTOMERS"."CUSTOMER_COUNT"
  WHERE "CUSTOMERS"."CUSTOMER_NAME" = ?
) LIMIT 10
```

returned exactly one row, `(1,)` — a single aggregate value, not one row per
customer. The filtered dimension is **not** silently added to the grouping.

So a KPI card showing one number can be filtered by a dimension it does not
display, which is the whole reason filters had to be pushed inside the call.
The spec's weaker fallback — requiring every filtered dimension to also appear
in `DIMENSIONS` — is not needed and no sign-off is required.

The spike asserts the row count rather than merely that the statement ran,
so this stays proven rather than assumed.

## Q4 — clause order

Accepted, 5 rows. `WHERE` goes inside the call; `ORDER BY` and `LIMIT` go
outside it, after the closing paren:

```sql
SELECT * FROM SEMANTIC_VIEW(
  "SEMANTIC_DEMO"."TPCH"."TPCH_SALES_ANALYTICS"
  DIMENSIONS "CUSTOMERS"."CUSTOMER_NAME"
  METRICS "CUSTOMERS"."CUSTOMER_COUNT"
  WHERE "CUSTOMERS"."CUSTOMER_NAME" <> ?
) ORDER BY "CUSTOMER_COUNT" DESC LIMIT 5
```

This matches how `build_semantic_sql` already assembles `ORDER BY`/`LIMIT`,
so appending `WHERE` to the inner `parts` list is the only change needed.

`ORDER BY` continues to reference the **bare** column name (`"CUSTOMER_COUNT"`),
not the qualified one — unchanged from the existing builder.

## What the implementation must do

1. `PLACEHOLDER = "?"` in `app/semantic/predicates.py`.
2. `paramstyle="qmark"` on every `snowflake.connector.connect(...)` call in
   `app/snowflake/connect.py` — without it, `?` placeholders fail client-side.
3. Append `WHERE <predicates joined by AND>` to the inner `parts` list in
   `build_semantic_sql`, after `METRICS`, before the closing paren.
4. Qualify filter fields as `"TABLE"."FIELD"`, same as `DIMENSIONS`.

## Note on the test account

`SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS` has no text dimension the spike
recognised by data type, so it fell back to the first dimension of any type
(`CUSTOMERS.CUSTOMER_NAME`, which is textual in practice). Every question was
still answered. Pinning `SEMANTICUI_IT_DATABASE` / `_SCHEMA` / `_VIEW` in
`backend/.env` keeps later integration runs on this same model rather than
whichever view happens to be listed first.
