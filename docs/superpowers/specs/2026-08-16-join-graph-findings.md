# What a semantic view lets you ask, and how we found out

**Date:** 2026-08-16
**Account:** the live development account, `SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS`
**Method:** roughly eighty generated `SEMANTIC_VIEW(...)` queries, each run and
its error read.

This exists because none of it is documented, all of it is load-bearing, and
two modules now encode it — `backend/app/semantic/joins.py` and
`frontend/src/explorer/joins.ts`. Rules discovered by experiment can go stale
without anybody being told, so `backend/tests/integration/test_joins_it.py`
re-runs the load-bearing cases against Snowflake.

## The symptom

Picking two ordinary-looking fields could fail:

```
010958 (42601): SQL compilation error: Invalid dimension specified: The
dimension entity 'SUPPLIER' is not directly related to the base dimension
entity 'PART'. Consider using one of the following as a bridge to connect
them: LINEITEMS.
```

Three errors share that opening. They are not three bugs; they are one rule
seen from three angles.

| errno | Says | Happens when |
|---|---|---|
| 010956 | dimension entity has *higher granularity* than the base **metric** entity | a coarse measure, a finer dimension |
| 010957 | dimension entity *not directly related* to the base **metric** entity | a measure and a dimension on unconnected branches |
| 010958 | dimension entity *not directly related* to the base **dimension** entity | dimensions only, on unconnected branches |

## The graph

`DESCRIBE SEMANTIC VIEW` emits, per relationship, a `TABLE` property (the
foreign-key side) and a `REF_TABLE` property (the primary-key side). The
parser used to keep the relationship's *name* and discard both, which is why
none of this could be reasoned about before.

The pair is directed, and the direction is grain: following an edge always
moves from finer to coarser.

```
LINEITEMS ─┬─> ORDERS ──> CUSTOMERS ──> NATION ──> REGION
           ├─> PART
           └─> SUPPLIER
```

## The rule

**Every entity named in the query must be reachable from the base entity by
following edges.** What varies is which entity is the base.

* **Metrics present** — every metric's entity is a base in its own right, and
  every selected dimension must be reachable from *all* of them. A single
  coarse measure poisons the query no matter what else is selected.
* **Dimensions only** — Snowflake looks for a selected entity that reaches all
  the others. `CUSTOMERS.CUSTOMER_NAME + ORDERS.ORDER_DATE` works because
  ORDERS reaches CUSTOMERS. `PART.BRAND + SUPPLIER.SUPPLIER_NAME` fails
  because neither reaches the other.

### Clause order is irrelevant

Worth stating because it is the obvious first guess and it is wrong. With
metrics `ORDERS.ORDER_COUNT, LINEITEMS.TOTAL_QUANTITY` grouped by `PART.BRAND`,
listing the fine-grained LINEITEMS metric first does **not** make it the base:
the query fails on ORDERS either way. Reversing a failing dimension pair
likewise changes nothing but which entity the error names.

## What is repairable

A dimension-only query across unconnected entities is repairable, and the
error itself says how: name an entity that reaches both. It cannot enter as a
**dimension** — that would add rows, changing the grain of the answer. It can
enter as a **metric**, which adds a column, and the column can then be dropped
in the projection:

```sql
SELECT * EXCLUDE ("TOTAL_QUANTITY") FROM SEMANTIC_VIEW(
  db.schema.view
  DIMENSIONS "PART"."BRAND", "SUPPLIER"."SUPPLIER_NAME"
  METRICS "LINEITEMS"."TOTAL_QUANTITY"
)
```

`SELECT * EXCLUDE` was confirmed to work over a `SEMANTIC_VIEW(...)` call,
including alongside `ORDER BY`.

Two properties make this safe rather than clever:

1. **It changes nothing when it is not needed.** `PART.BRAND` alone returns 25
   rows; `PART.BRAND` with a LINEITEMS metric returns 25 rows.
2. **It is the only answer available.** "Which brands and suppliers go
   together" is a question about line items whether or not the user says so.
   It is still a narrowing — the result is combinations that *occur* — so the
   UI says which entity it went through rather than leaving that implicit.

## What is not repairable

Anything with a metric in it. Adding a bridging metric does not help, because
the user's own coarse metric is still a base and still cannot see the
dimension. `CUSTOMERS.CUSTOMER_COUNT` by `ORDERS.ORDER_DATE` has no repair:
the model defines that count at customer grain, and the question asks for it
at order grain.

The honest response is not to offer the combination. The field picker greys
out what the current selection has ruled out and says which selected field did
the ruling out — which is also why measures gate dimensions in the explorer
and dimensions almost never gate anything.
