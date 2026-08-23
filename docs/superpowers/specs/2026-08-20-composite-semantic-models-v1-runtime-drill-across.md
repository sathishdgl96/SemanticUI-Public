# Composite semantic models — v1: runtime drill-across

Status: **Implemented** on `feature/composite-models`, except Phase 0
(the spike against a real Snowflake account), which has not been run --
every SQL shape below is unit-tested but none has executed against a
warehouse
Date: 2026-08-20
Companion: [v2 — compiled semantic view](2026-08-20-composite-semantic-models-v2-compiled-semantic-view.md)

**Two tracks, deliberately.** v1 (this document) composes member views
**at query time**, inside the app, and writes nothing to the warehouse.
v2 compiles the composite into a real Snowflake `SEMANTIC VIEW` object
so Cortex Analyst and other Snowflake-native tools can reuse it.

v1 is being built first because it is **known feasible today** — it
rests on published Snowflake behaviour, needs no new grants, and leaves
no footprint in anyone's warehouse. v2 rests on an unverified
assumption (that `DESCRIBE SEMANTIC VIEW` exposes base-table mappings
and field expressions) and on authors holding `CREATE SEMANTIC VIEW`.

The two are not rivals. If v2 ships, v1 remains the fallback tier for:

- authors with no `CREATE SEMANTIC VIEW` grant anywhere;
- conformed dimensions whose keys are genuinely disjoint across members
  (no single semantic view can express "these two differently-keyed
  dimension tables are the same thing");
- ad-hoc composition where minting a warehouse object is ceremony.

**Known limitation of v1, stated up front:** the composite lives in this
app. Cortex Analyst, Sigma, dbt and anything else Snowflake-native
cannot see it. That is the gap v2 exists to close, and it is the reason
v1 alone is not the end state.

---

## 1. The problem, precisely

Snowflake's `SEMANTIC_VIEW()` clause queries **one view per call**, and
everything in this codebase inherits that boundary:

- `SemanticQueryRequest` (`app/semantic/query.py`) takes one
  `database/schema/view` triple and compiles one call.
- A report stores one view reference (`view_database/schema/name`).
- The XMLA endpoint maps **one view to one cube**
  (`app/xmla/discover.py: cube_name`), so Excel cannot see two views in
  one PivotTable.
- Join planning (`app/semantic/joins.py`) is reachability *within* a
  view's declared relationship graph.

An organisation's models do not stop at view boundaries. Sales and
Support are two semantic views owned by two teams, and "revenue per
ticket by customer by month" is a legitimate question that today needs
a data engineer to build a third view. The composite model is that
third view expressed as governed configuration instead of new warehouse
DDL.

## 2. What the warehouse permits (verified against docs, 2026-08-20)

Two facts decide the whole physical design:

1. The **plain `FROM semantic_view`** form (standard-SQL querying, GA
   2026-03-02) explicitly **forbids joins**, window functions, QUALIFY
   and lateral constructs.
2. The **`SEMANTIC_VIEW(...)` clause** is explicitly allowed inside
   "other SQL constructs, including JOIN, PIVOT, UNPIVOT, GROUP BY, and
   common table expressions (CTEs)".

So a composite query is compilable as **one statement**: one CTE per
member view — each a `SEMANTIC_VIEW()` call, aggregated by that view's
own engine at the requested grain, filters pushed inside — joined on
conformed dimension keys at the top. No app-side merging, no second
round trip, no result marshalling through Python.

**Phase 0 verifies this against a real account before anything else is
built** (§10). The join-graph rules in `joins.py` were established
empirically because the documentation was silent; this feature's
foundation gets the same treatment. Fallback if CTE placement
misbehaves: derived-table joins (`... JOIN (SELECT ... FROM
SEMANTIC_VIEW(...)) b ON ...`), which the same documentation blesses.

## 3. Prior art, and what we take from each

**Kimball drill-across** (the 1996 answer, still the right one): never
join fact rows across stars. Query each fact table *separately*,
aggregated to the conformed-dimension grain, then merge the summarised
row sets on the conformed attributes with a full outer join. Every
serious implementation below is this idea wearing different clothes.

**AtScale** — the closest commercial comparable. A universal semantic
layer: one logical model over warehouse tables, multi-fact modelling,
queries planned per fact table and stitched on conformed dimensions,
exposed simultaneously over XMLA/MDX/DAX/SQL so Excel and Power BI see
a cube while SQL clients see tables. Its headline differentiators are
**aggregate awareness** — the engine watches query patterns,
auto-creates aggregate tables in the warehouse, and rewrites incoming
queries to hit them — and speaking every BI protocol at once.
*Take:* the planner shape (per-fact branches + conformed-dim stitch),
and cube surfacing via **measure groups** (§8). *Deliberately not
taken:* app-managed aggregates (§9) and the service-account execution
model — every AtScale query runs as AtScale; every query here runs as
the caller (ADR 0001), which is the product's core guarantee.

**dbt MetricFlow** — metrics belong to semantic models; entities (keys)
are the join graph; the planner builds a dataflow of per-model
subqueries joined on entity keys, pre-aggregating before joins to kill
fan-out. *Take:* metrics are owned by exactly one member view and
routed there; joins happen only on declared shared entities, never
inferred from column names.

**Cube** — "cubes" (per-source models) composed into "views" that
expose a curated, joined surface to consumers. *Take:* the composite is
a **separate, curated object** that names its members and exposes a
deliberate field list — not an automatic union of everything.

**Power BI composite models** — the cautionary tale. Cross-source
"limited relationships" silently change semantics (no blank-row
matching, one-side filters only), and users discover it as wrong
numbers. *Take:* where composite semantics differ from single-view
semantics (asymmetric filters, §7.3), the difference is **explicit,
documented, and chosen at model definition time** — never silent.

## 4. The composite model object

A new workspace-owned object, beside reports/dashboards/explores: same
membership gate, same 404-not-403, same export/import as a portable
document, same audit funnels.

```jsonc
{
  "schemaVersion": 1,
  "name": "Customer 360",
  "members": [
    { "alias": "sales",   "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES_SV" },
    { "alias": "support", "database": "ANALYTICS", "schema": "PUBLIC", "view": "SUPPORT_SV" }
  ],
  // Conformed dimensions: n-ary by design. Two views need one mapping;
  // five views must not need ten pairwise ones.
  "sharedDimensions": [
    {
      "name": "Customer",
      "bindings": {
        "sales":   { "table": "CUSTOMER", "column": "CUSTOMER_ID" },
        "support": { "table": "CLIENT",   "column": "CLIENT_ID" }
      },
      // What the user reads; keys join, labels display.
      "labels": {
        "sales":   { "table": "CUSTOMER", "column": "NAME" },
        "support": { "table": "CLIENT",   "column": "CLIENT_NAME" }
      }
    },
    {
      "name": "Month",
      "bindings": {
        "sales":   { "table": "ORDERS",  "column": "ORDER_MONTH" },
        "support": { "table": "TICKETS", "column": "OPENED_MONTH" }
      }
    }
  ],
  // Post-join arithmetic over member metrics. Evaluated AFTER each
  // branch has aggregated -- the only place a cross-view ratio is honest.
  "derivedMetrics": [
    { "name": "Revenue per ticket",
      "expr": { "op": "/", "left": {"metric": "sales:REVENUE"},
                            "right": {"metric": "support:TICKET_COUNT"} },
      "nullIfDenominatorZero": true }
  ],
  "joinType": "full",          // full | inner -- a MODEL decision, not per query
  "crossFilter": "semi"        // semi | local -- §7.3, chosen here, said out loud
}
```

Field references in the composite namespace are alias-qualified
(`sales:ORDERS.REVENUE`), so name collisions between member views can
never be ambiguous; display names may collide freely.

**Save-time validation** (all against the member views' DESCRIBE, via
the existing describe cache): every binding exists; binding column
types are join-compatible per shared dimension; aliases unique; derived
metric references resolve; ≥1 shared dimension when there are ≥2
members; member count ≤ 8 and shared dimensions ≤ 12 (stated caps —
§9). `derivedMetrics.expr` is a small closed AST (`+ - * /`, metric
refs, numeric literals), the same discipline as filters: **never an
expression string that reaches SQL text**.

**Access is intersection, not union.** Every branch runs on the
caller's own connection. A user who cannot SELECT view B gets a refusal
that names the view — the composite cannot widen anyone's access, which
keeps the property FEATURES.md leads with true by construction.

## 5. The semantic planner (logical)

Input: dimensions, metrics, filters, orderBy against the *composite*
namespace. Output: a branch plan per member view actually touched, plus
a stitch spec. Pure function of (definition, query, member describes) —
no I/O, so it is unit-testable exhaustively, like `plan_join`.

1. **Route metrics.** Each metric (or raw-fact aggregation) belongs to
   exactly one member. Members with no requested metric and no
   requested local dimension contribute no branch — *branch pruning*:
   a query touching one view compiles to that view alone.
2. **Resolve dimensions.** A shared dimension maps to its binding in
   each active branch. A view-local dimension forces its owner into the
   plan and is legal only when every requested metric lives in that
   same view *or* the dimension is shared — otherwise the refusal says
   which dimension to share or drop (the same voice as the FACTS rule
   in `query.py`).
3. **Push filters.** Shared-dimension filters compile into every
   branch, through each branch's own binding. View-local filters
   compile into their owner; their effect on other branches is §7.3.
4. **Per-branch legality.** Each branch is checked against that view's
   own join graph — `plan_join` and its bridge repair, **reused
   unchanged**. Composite planning sits above single-view planning; it
   never reimplements it.
5. **Stitch spec.** Join keys (the shared-dimension bindings), join
   type from the definition, COALESCE list for shared columns, derived
   metric expressions, top-level order/limit.

## 6. The query planner (physical)

Each branch compiles through the **existing** `build_semantic_sql`,
gaining one flag: `as_branch=True` suppresses top-level ORDER BY and
replaces the user LIMIT with a protective branch cap. The single-view
path stays **byte-identical** — a test asserts it, because every
existing report and every Excel refresh rides on that path.

```sql
WITH "b_sales" AS (
  SELECT * FROM SEMANTIC_VIEW(
    "ANALYTICS"."PUBLIC"."SALES_SV"
    DIMENSIONS "CUSTOMER"."CUSTOMER_ID", "CUSTOMER"."NAME", "ORDERS"."ORDER_MONTH"
    METRICS "ORDERS"."REVENUE"
    WHERE "ORDERS"."ORDER_MONTH" >= ?
  )
),
"b_support" AS (
  SELECT * FROM SEMANTIC_VIEW(
    "ANALYTICS"."PUBLIC"."SUPPORT_SV"
    DIMENSIONS "CLIENT"."CLIENT_ID", "TICKETS"."OPENED_MONTH"
    METRICS "TICKETS"."TICKET_COUNT"
    WHERE "TICKETS"."OPENED_MONTH" >= ?
  )
)
SELECT
  COALESCE("b_sales"."CUSTOMER_ID", "b_support"."CLIENT_ID") AS "Customer",
  COALESCE("b_sales"."ORDER_MONTH", "b_support"."OPENED_MONTH") AS "Month",
  "b_sales"."NAME"          AS "Customer Name",
  "b_sales"."REVENUE"       AS "Revenue",
  "b_support"."TICKET_COUNT" AS "Tickets",
  CASE WHEN "b_support"."TICKET_COUNT" = 0 THEN NULL
       ELSE "b_sales"."REVENUE" / "b_support"."TICKET_COUNT"
  END AS "Revenue per ticket"
FROM "b_sales"
FULL OUTER JOIN "b_support"
  ON "b_sales"."CUSTOMER_ID" = "b_support"."CLIENT_ID"
 AND "b_sales"."ORDER_MONTH" = "b_support"."OPENED_MONTH"
ORDER BY "Revenue" DESC
LIMIT 201
```

Properties worth stating:

- **One statement, one round trip**, all aggregation and joining inside
  the warehouse on the caller's own connection. Nothing row-shaped
  transits the app that the user did not ask to see.
- **Bound parameters are positional** (qmark): each branch's params
  concatenate in branch order. The planner owns that ordering; a test
  pins it, because a silent off-by-one here binds the wrong value to
  the wrong filter and produces *plausible wrong numbers* — the worst
  failure mode this product can have.
- Every identifier passes `quote_ident`; every value binds. The
  composite adds joins and arithmetic, never a new way for input to
  reach SQL text.
- The `LIMIT cap+1` truncation-notice idiom carries over at the top
  level; branch caps guard against a shared dimension with pathological
  cardinality.

## 7. The scenarios that decide whether this is trustworthy

### 7.1 Fan and chasm traps — impossible by construction

Row-level joins across grains multiply measures; that is the classic
way blended numbers go wrong. Here each branch is aggregated *by the
view's own engine* to exactly the requested shared grain before any
join exists. There is no code path that joins raw rows across members.
This is the design's single most important property and it falls out of
the CTE shape rather than being enforced by review.

### 7.2 Non-additive and distinct metrics

Within a branch: the member view computes them; already correct. Across
branches: derived metrics are post-aggregation arithmetic only. A
cross-view `COUNT(DISTINCT)` over a merged entity is **not
expressible** and is refused with a sentence naming the closest honest
alternative (define it in a warehouse view). Refusing loudly beats
approximating silently.

### 7.3 Asymmetric filters — the one real semantic fork

Filter on `sales`-only dimension REGION, while showing `support`
tickets. Two defensible meanings:

- **`local`** — the filter constrains the sales branch only; ticket
  counts are global. Simple, sometimes wanted, often misread.
- **`semi`** (default) — the other branches are additionally
  constrained to the shared-dimension keys that *survive* the filtered
  branch: the support CTE gains
  `WHERE ("CLIENT_ID","OPENED_MONTH") IN (SELECT "CUSTOMER_ID","ORDER_MONTH" FROM "b_sales")`
  (compiled as a semi-join, not a literal list). "Tickets for the
  customers this filter left" — what a person filtering a composite
  almost always means.

Power BI's failure was making this choice silently. Here it is a
**model-level setting**, shown in the model UI and the field-list
tooltip, and the Phase 0 spike measures the semi-join's cost so the
default is chosen on evidence.

### 7.4 Grain and rollup mismatches

v1 bindings are column-to-column: conforming happens in the member
views (both expose a month column). Expression bindings (e.g.
`DATE_TRUNC` adapters) are explicitly deferred — they reopen the
values-never-in-SQL-text contract and earn their complexity later, if
real models demand it.

### 7.5 Partial presence

`full` join + COALESCE keeps customers with tickets but no revenue, and
vice versa. NULL stays NULL — a missing measurement is not zero, and
renderers already draw gaps. Per-metric zero-fill is a rendering
option, never the planner's invention.

### 7.6 Drift

Member views evolve underneath the composite. Save-time validation
covers creation; a background-free, on-read check covers life
afterwards: when a describe no longer contains a binding, the query
fails with *which binding on which view* broke, the model page shows
"needs review" against the same check, and the audit row records a
shape (`bindings_broken: 1`), never a name.

## 8. Surfacing inside this app

- **Explorer / reports / dashboards.** Report and explore definitions
  gain a source union: `{view} | {composite}`. The field list shows
  shared dimensions once, then per-member sections. Everything
  downstream of "the query returned columns" — renderers, filters UI,
  drill, export — is unchanged, which is most of the product.
- **Excel (XMLA).** One composite = one cube; each member view = one
  **measure group** — `MDSCHEMA_MEASUREGROUPS` is already emitted
  today, one group per view; this design finally uses the rowset for
  what SSAS meant it for. Shared dimensions are cube dimensions;
  member-local dimensions are related only to their measure group via
  `MDSCHEMA_MEASUREGROUP_DIMENSIONS`, so Excel itself greys out
  illegal dimension/measure pairings before a query is ever sent — the
  join-graph-refusal experience, implemented by the client for free.
  MDX execution routes through the same two planners.
- **Chat.** The proposal context becomes the member describes plus the
  shared-dimension map; the model proposes composite queries under the
  same never-executes, SQL-always-shown contract.
- **Model diagram.** Member views render as clusters; shared dimensions
  draw as edges between clusters. React Flow + dagre already handle
  grouped layouts; `relatedFields` extends across bindings.
- **Not surfaced anywhere else.** Cortex Analyst, Sigma, dbt and every
  other Snowflake-native consumer see nothing — see the header, and v2.

## 9. Scale and performance posture

Same discipline as the 500-user work: count statements, bound results,
push work into the engine that is priced for it.

- **One statement per composite render**; branch pruning makes the
  single-member case exactly today's query. Statement-count tests
  extend to composite paths.
- **Describe stays cached** per session per member; a composite of 4
  views warms 4 describes once, not per query.
- **Plan cache**: canonical (composite hash, query shape) → compiled
  SQL skeleton; params always re-bound. Skips replanning, never reuses
  results — nothing crosses users (ADR 0001 is untouched).
- **Aggregate awareness is deliberately Snowflake's job.** AtScale's
  auto-aggregate engine exists because it fronts many warehouses and
  cannot assume any of them accelerates. This product fronts exactly
  one, which ships Query Acceleration Service and materialized views on
  the underlying tables — and the semantic view's own engine already
  picks access paths. The app managing aggregate tables would add a
  writer identity (breaking own-connection-only), a freshness problem,
  and a cache of other people's data. The optimisation lever an
  operator gets is warehouse-native, documented, and shared with every
  other Snowflake workload. This is the biggest deliberate divergence
  from AtScale and it is a feature, not a gap.
- **Stated caps** (≤ 8 members, ≤ 12 shared dimensions, branch row
  caps) with sentences when hit — the "bounded and says so" listing
  rule, applied to planning.

## 10. Delivery plan

Each phase ships alone, is testable alone, and phase N never breaks the
single-view paths phase N−1 relied on.

**Phase 0 — spike against a real account** *(gate for everything)*
CTE-embedded `SEMANTIC_VIEW()` with WHERE + bound params; positional
binding across two branches; FULL OUTER + COALESCE shape; semi-join
cross-filter cost; the three "Invalid dimension" flavours inside a CTE.
Output: a findings doc beside the join-graph one, and the go/no-go on
the physical design (fallback: derived-table joins).

**Phase 1 — the object.** Migration 0013 (`composite_models`, workspace
FK), CRUD + save-time validation, export/import, audit actions
(`composite.create/read/update/delete` added to `EXPECTED_ACTIONS`),
browse-list integration as a fourth kind. No querying yet.

**Phase 2 — the planners.** Semantic planner (pure, exhaustively
unit-tested: routing, pruning, filter pushdown, legality refusals with
named fields); `as_branch` mode on `build_semantic_sql` with the
byte-identical single-view test; stitcher; `/api/semantic/query`
accepts the composite source; explorer runs it. Integration tests
re-run Phase 0's load-bearing cases.

**Phase 3 — reports and filters.** Source union on report/explore
definitions (schema version bump + migration of nothing — old documents
stay valid); field pickers; cross-filter semantics (`semi`/`local`)
wired through report/page/visual filter scopes; model diagram clusters.

**Phase 4 — Excel.** Measure-group surfacing in DISCOVER; MDX SELECT
routed through the planners; ADOMD harness pass (the
xmla-excel-protocol-rules debug rig) against a composite cube.

**Phase 5 — hardening.** Plan cache; drift detection UX; caps and
truncation notices; FEATURES.md, SECURITY.md (composite adds no new
trust boundary — say so and why), README, and a `docs/operations` note
on warehouse-side acceleration as the tuning lever.

## 11. Risks

| Risk | Mitigation |
|---|---|
| CTE-embedded `SEMANTIC_VIEW()` misbehaves somewhere docs don't cover | Phase 0 gate; derived-table fallback; findings recorded like the join-graph work |
| Positional param misalignment across branches | Planner owns ordering; dedicated tests; params never built in two places |
| Semi-join cross-filter too slow on wide keys | Measured in Phase 0; `local` mode exists; key-only branch projection |
| Users blend semantically unrelated views and trust the numbers | Curated object with explicit shared dims — no auto-join; validation refuses keyless composites; docs say what a conformed dimension is |
| Excel behaves oddly with measure-group dimension restrictions | The ADOMD harness exists precisely for this; SSAS semantics are the most-trodden path in that protocol |
| Composite is invisible to Cortex and other native consumers | Accepted for v1; v2 is the answer, and the authoring document is deliberately shaped so a compiler can consume it later |
| Scope creep toward federation/acceleration | Non-goals below, written down |

## 12. Non-goals

- **No cross-engine federation.** Members are Snowflake semantic views
  in accounts the caller can reach. Blending Snowflake with something
  else is a different product.
- **No app-managed aggregates or cross-user result caches** (§9,
  ADR 0001).
- **No automatic join inference.** Shared dimensions are declared by a
  person who understands both models, or they do not exist.
- **No writeback, no new DDL in the warehouse.** A composite is a
  definition — sharing one shares a definition, never numbers. *(v2
  amends exactly this one, to "no service identity, ever": it writes
  DDL, but only ever as the author.)*

---

*Prior-art references: AtScale universal semantic layer / aggregate
awareness (atscale.com platform docs), Snowflake semantic-view SQL
querying GA 2026-03-02 and relationship-path preview 2026-03-13
(docs.snowflake.com), dbt MetricFlow dataflow planning, Cube views,
Kimball drill-across; Snowflake CTE/JOIN support for the
`SEMANTIC_VIEW` clause verified at
docs.snowflake.com/en/user-guide/views-semantic/querying on the date
above.*
