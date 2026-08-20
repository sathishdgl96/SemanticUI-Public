# Composite semantic models — design plan

Status: Proposed, v2 (plan only; nothing here is built)
Date: 2026-08-20
Revision: v2 replaces v1's storage decision. v1 stored the composite as
an app document and joined at query time; v2 **compiles the composite
into a real Snowflake `SEMANTIC VIEW` object**, so Cortex Analyst,
Snowflake Intelligence, and every other Snowflake-native consumer can
reuse it. v1's runtime join survives as the fallback tier (§7). The
question that forced the change: "why would the definition live where
only this app can read it?" — it shouldn't.

One model over several Snowflake semantic views, usable everywhere a
single view is usable today — explorer, reports, dashboards, chat,
Excel — **and** by tools that are not this app.

```
        author edits in the app UI
                    |
              SEMANTIC PLANNER            (merge member models, map
                    |                      conformed dims, validate)
                    v
        CREATE SEMANTIC VIEW  "COMPOSITE_CUSTOMER_360"
        -- run on the AUTHOR'S OWN connection, in a schema
        -- the operator designates
                    |
   +----------------+---------------------------+
   |                |                           |
 this app      Cortex Analyst /            Sigma, dbt, any
 (existing     Snowflake Intelligence      Snowflake-native
 single-view   (semantic views are its     consumer, via
 query path)   RECOMMENDED input)          SELECT grants
```

---

## 1. The problem, precisely

Snowflake's `SEMANTIC_VIEW()` clause queries **one view per call**, and
everything in this codebase inherits that boundary:

- `SemanticQueryRequest` (`app/semantic/query.py`) takes one
  `database/schema/view` triple and compiles one call.
- A report stores one view reference; the XMLA endpoint maps one view
  to one cube (`app/xmla/discover.py: cube_name`), so Excel cannot see
  two views in one PivotTable.
- Join planning (`app/semantic/joins.py`) is reachability *within* one
  view's declared relationship graph.

Sales and Support are two semantic views owned by two teams; "revenue
per ticket by customer by month" is a legitimate question that today
needs a data engineer to hand-build a third view. The composite model
is that third view — **generated** instead of hand-built, and
**governed** instead of copy-pasted.

## 2. Where the model lives: in Snowflake, as a real semantic view

This is the load-bearing decision of v2, and the reasons stack:

1. **Cortex reuses it.** Cortex Analyst's documentation now names
   semantic views the *recommended* model input (legacy YAML-on-stage
   is back-compat only). A composite compiled to a `SEMANTIC VIEW`
   object is immediately usable by Cortex Analyst, Snowflake
   Intelligence and Cortex Agents — the exact reuse being asked for —
   with no export step and no second copy of the semantics.
2. **Governance moves to where it belongs.** Sharing the composite is a
   Snowflake `GRANT SELECT / REFERENCES`, visible in Horizon, auditable
   in ACCESS_HISTORY, revocable by the people who own data governance —
   not a row in this app's Postgres. The app's workspace membership
   still decides who sees the *authoring surface*; Snowflake decides
   who can *query*, exactly as it does for every base table today.
3. **The app's runtime collapses.** A compiled composite is just
   another semantic view, so:
   - the **existing single-view query builder runs it unchanged** — no
     CTE stitching, no cross-branch parameter ordering, no second
     planner in the hot path;
   - the **existing XMLA path lists it automatically**
     (`list_semantic_views` enumerates whatever the caller can see), so
     Excel gets the composite as a cube with **zero new protocol
     code**;
   - v1's hardest correctness item — asymmetric cross-view filter
     semantics — **disappears**: there is one join graph and
     Snowflake's own engine owns its semantics.
4. **The security model is untouched.** The DDL runs on the **author's
   own connection** — they need `CREATE SEMANTIC VIEW` on a schema the
   operator designates (e.g. `ANALYTICS.COMPOSITES`) plus `USAGE` on
   its database and schema. The app never acquires a writer identity;
   ADR 0001 (own connection only) holds. A user who cannot create is
   told so in Snowflake's words; a user who cannot SELECT a member's
   base tables cannot smuggle access through the composite, because the
   composite's queries still run as *them*.

**What the app stores**: a thin workspace object — name, the
fully-qualified warehouse object it points at, and the **authoring
document** (the intent: members, conformed-dimension mappings, derived
metrics). The warehouse object is the executable truth; the authoring
doc is what makes "edit the composite" round-trip without parsing DDL.
On every edit the app re-validates intent against the members' current
DESCRIBE and re-issues `CREATE OR REPLACE SEMANTIC VIEW` — again as the
author. Lineage (which members, which app object, which version) is
stamped in the object `COMMENT`, so a warehouse admin looking at the
object in Snowsight knows exactly where it came from.

## 3. The authoring model

Unchanged from v1 in shape — this is what the UI edits and the compiler
consumes:

```jsonc
{
  "schemaVersion": 2,
  "name": "Customer 360",
  "target": { "database": "ANALYTICS", "schema": "COMPOSITES" },
  "members": [
    { "alias": "sales",   "database": "ANALYTICS", "schema": "PUBLIC", "view": "SALES_SV" },
    { "alias": "support", "database": "ANALYTICS", "schema": "PUBLIC", "view": "SUPPORT_SV" }
  ],
  // Conformed dimensions: n-ary by design -- five members must not
  // need ten pairwise mappings.
  "sharedDimensions": [
    { "name": "Customer",
      "bindings": {
        "sales":   { "table": "CUSTOMER", "column": "CUSTOMER_ID" },
        "support": { "table": "CLIENT",   "column": "CLIENT_ID" } } },
    { "name": "Month",
      "bindings": {
        "sales":   { "table": "ORDERS",  "column": "ORDER_MONTH" },
        "support": { "table": "TICKETS", "column": "OPENED_MONTH" } } }
  ],
  // Compiled to Snowflake's native derived metrics (metrics may span
  // tables). A closed AST, never an expression string.
  "derivedMetrics": [
    { "name": "REVENUE_PER_TICKET",
      "expr": { "op": "/", "left": {"metric": "sales:REVENUE"},
                            "right": {"metric": "support:TICKET_COUNT"} },
      "nullIfDenominatorZero": true }
  ],
  // Which fields the composite EXPOSES. Everything else is compiled
  // with private access modifiers -- present for correctness,
  // invisible to consumers. This is also what keeps the surface small
  // enough for Cortex Analyst to answer well.
  "exposed": ["Customer", "Month", "sales:REVENUE", "support:TICKET_COUNT",
              "REVENUE_PER_TICKET"]
}
```

Joins are **declared by a person, never inferred** — a conformed
dimension exists because someone who understands both models says the
two columns mean the same thing. Save-time validation checks every
binding against the members' DESCRIBE (cached), type-compatibility per
shared dimension, alias uniqueness, resolvable derived-metric
references, and the caps (≤ 8 members, ≤ 12 shared dimensions), each
refusal a sentence naming the field.

## 4. The compiler

`DESCRIBE SEMANTIC VIEW` on each member yields its logical tables,
relationships, dimensions, facts and metrics. The compiler merges them
into one `CREATE OR REPLACE SEMANTIC VIEW`:

1. **Logical tables** from every member, alias-prefixed on collision
   (`SALES_ORDERS`, `SUPPORT_TICKETS`) — collisions renamed, never
   guessed about.
2. **Conformed dimensions unify.** Two cases, decided per shared
   dimension at save time:
   - *Same base table* under both members' dimension tables (the common
     case — both views model `DIM_CUSTOMER`): the compiler emits **one**
     logical table and points both members' relationship edges at it.
     The result is a textbook multi-fact star: `ORDERS → CUSTOMER ←
     TICKETS`, which the semantic-view engine answers natively — and
     whose base-entity rules the join-graph work has already mapped
     empirically.
   - *Different base tables* (`DIM_CUSTOMER` vs `DIM_CLIENT`): one is
     chosen canonical (declared in the mapping, not guessed) **if** the
     other fact's FK column is key-compatible with it; the compiler
     emits the relationship accordingly. If neither side can serve —
     keys genuinely disjoint, needing COALESCE-of-keys — the composite
     is **not expressible** as one semantic view, and this model falls
     to Tier 2 (§7) with a message saying which dimension and why.
3. **Relationships, metrics, facts** carry over verbatim from each
   member (they already reference their own tables); derived metrics
   compile to Snowflake's native derived-metric syntax; everything not
   in `exposed` gets a private access modifier.
4. The DDL is assembled entirely from `quote_ident`-validated
   identifiers and literal grammar — the values-never-in-SQL-text
   contract extends to DDL unchanged.
5. Execute on the author's connection; stamp lineage in `COMMENT`;
   record `composite.compile` in the audit trail (shapes only: member
   count, table count, exposed count).

**Drift.** The compiled object references *base tables*, so it keeps
working even if a member view is later edited — it drifts from the
members' current shape, not from the data. On next edit, the app diffs
intent against fresh DESCRIBEs and recompiles; the model page shows
"members changed since last compile" from the same diff. Deleting the
app object offers — never forces — `DROP SEMANTIC VIEW`, again as the
author.

## 5. What each consumer sees

- **This app.** Reports, dashboards, explores and chat reference the
  composite exactly as they reference any semantic view — the source
  union `{view | composite}` from v1 shrinks to bookkeeping, because
  after compilation *it is a view*. The existing query builder,
  filters, join-graph planner, renderers and export work unchanged.
- **Excel.** The composite appears as one more cube through the
  existing XMLA path the moment it exists. Measure-group surfacing per
  member (v1 §8) becomes an optional nicety, not a prerequisite.
- **Cortex Analyst / Snowflake Intelligence.** Point them at the
  object; the `exposed` list doubles as the curated surface that keeps
  the model inside the size Cortex answers well (Snowflake's guidance:
  modest column counts; the YAML spec caps at 1 MB). The caller needs
  the `CORTEX_USER`-family role and SELECT on the referenced data —
  their problem in the best sense: Snowflake governance, not app
  configuration.
- **Everything else** (Sigma, dbt, notebooks): `GRANT SELECT` and go.

## 6. Correctness properties, restated for v2

- **Fan/chasm traps**: the multi-fact star is answered by Snowflake's
  semantic engine, whose base-entity rules require every metric's
  entity to reach every selected dimension — the empirically-mapped
  behaviour in `joins.py` applies as-is, refusals included.
- **Non-additive metrics**: computed by the view engine per its own
  definitions; cross-member `COUNT(DISTINCT)` over a merged entity
  remains inexpressible and refused with a sentence.
- **Partial presence**: the engine's multi-fact semantics govern; the
  Phase 0 spike records what it does with fact-less dimension rows so
  the docs can say it plainly rather than users discovering it.
- **Access**: intersection by construction — every query runs as the
  caller against base tables they must be able to read.

## 7. Tier 2 — runtime drill-across (v1's design, demoted to fallback)

Kept, de-scoped, for the cases compilation cannot serve:

- the author has no `CREATE SEMANTIC VIEW` grant anywhere (a pure
  analyst persona in a locked-down shop);
- a conformed dimension needs COALESCE-of-keys across genuinely
  disjoint dimension tables (§4.2);
- ad-hoc, throwaway composition where minting a warehouse object is
  ceremony.

Mechanism as v1: one statement, one CTE per member — each a
`SEMANTIC_VIEW()` call aggregating itself at the shared grain, filters
pushed inside — full-outer-joined on binding keys with COALESCE, the
`SEMANTIC_VIEW` clause being documented-legal inside CTEs and JOINs.
Fan-out stays impossible by construction (branches pre-aggregate).
Its costs are why it is the fallback: cross-branch positional-parameter
ordering, the asymmetric-filter semantics fork (`semi`/`local`), and
invisibility to Cortex. Tier is decided at save time and shown in the
UI with the reason.

## 8. Scale and reliability posture

- **Query path**: identical to today's single-view path for compiled
  composites — one statement, describe cached per session, constant
  statements per interaction. The 500-user discipline inherits intact.
- **Compile path**: rare (author edits only), a handful of DESCRIBEs
  plus one DDL, all on the author's connection.
- **Acceleration stays Snowflake's job**: Query Acceleration Service
  and materialized views on base tables serve the compiled composite
  like any semantic view. No app-managed aggregates, no cross-user
  result cache — AtScale's aggregate engine exists because it fronts
  many warehouses; we front one that accelerates natively, and an
  app-side cache would break own-connection-only.
- **Audit**: `composite.create/read/update/delete/compile` join
  `EXPECTED_ACTIONS`; details are shapes (counts, flags), never names.
- **No cross-account replication** for semantic views (Snowflake
  limitation as of mid-2026) — multi-account estates recompile per
  account; the authoring doc makes that a button, not a project.

## 9. Prior art (unchanged from v1, abridged)

Kimball drill-across is the correctness backbone (aggregate to the
conformed grain, then merge); AtScale demonstrates the virtual-cube
surface and multi-fact planning but funnels through a service identity
and manages its own aggregates — both deliberately refused here; dbt
MetricFlow demonstrates metric-to-model routing over declared entities;
Cube demonstrates the curated exposed-surface layer; Power BI composite
models are the cautionary tale that silent cross-source semantics read
as wrong numbers. v2 adds the lesson their architectures all imply:
**the reusable artifact should live in the engine, not the middleware**
— they could not put it there; on Snowflake, we can.

## 10. Delivery plan

**Phase 0 — spike, on a real account** *(gate)*: `DESCRIBE → merge →
CREATE SEMANTIC VIEW` round-trip for the two-member star; multi-fact
query behaviour incl. fact-less dimension rows; derived metrics
spanning tables; private access modifiers; `GRANT SELECT` consumption
from a second role; Cortex Analyst smoke test against the compiled
object; the Tier 2 CTE probe (params, join, cost) so the fallback's
feasibility is known too. Findings doc beside the join-graph one.

**Phase 1 — object + compiler.** Migration 0013 (thin pointer +
authoring doc, workspace FK); CRUD; save-time validation; the compiler;
lineage comments; audit actions; browse-list as a fourth kind.

**Phase 2 — consumption.** Source union on reports/explores (mostly
bookkeeping — the runtime path is the existing one); field pickers show
the exposed surface; model diagram renders members as clusters with
conformed-dimension edges; FEATURES/SECURITY/README updates, plus an
operations note: the designated schema, the grants an operator issues,
and pointing Cortex Analyst at a composite.

**Phase 3 — Excel polish.** Verify the composite cube through the ADOMD
harness; optional measure-group grouping of measures per member.

**Phase 4 — Tier 2 runtime**, only when a real deployment hits a
non-expressible case; the Phase 0 findings keep it honest.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Compiled multi-fact star answers differently than members did separately | Phase 0 measures exactly this; the join-graph IT suite pattern re-applied |
| Authors lack CREATE grants in locked-down shops | Tier 2 exists; operations doc tells the operator what to grant and where |
| Merged model too large for Cortex to answer well | `exposed` + private modifiers keep the surface curated; caps refuse loudly |
| DDL generation becomes an injection surface | Identifiers via `quote_ident`, grammar literal, no user expression strings — same contract as queries, tested the same way |
| Object dropped/renamed in Snowflake behind the app | Pointer resolves on read; a missing object names itself; recompile from the authoring doc is one action |
| Two sources of truth (doc vs object) drift | The object is truth for execution; the doc is truth for intent; every edit recompiles; the diff is shown, never silently reconciled |

## 12. Non-goals

- **No service identity, ever.** DDL runs as the author, explicitly, in
  a schema the operator designates. (v1's "no DDL in the warehouse"
  non-goal is amended to exactly this — the earlier phrasing would have
  forbidden the feature.)
- **No cross-engine federation** — members are Snowflake semantic
  views, period.
- **No app-managed aggregates or cross-user result caches** (ADR 0001).
- **No automatic join inference** — no declared conformed dimension, no
  composite.

---

*Verified 2026-08-20 against docs.snowflake.com: Cortex Analyst
recommends semantic views as model input (YAML legacy); CREATE SEMANTIC
VIEW privileges and SELECT/REFERENCES grants; derived metrics spanning
tables; public/private access modifiers; SEMANTIC_VIEW clause legal in
CTEs/JOINs (Tier 2); no cross-account replication as of mid-2026.*
