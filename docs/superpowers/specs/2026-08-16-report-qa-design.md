# Ask a Report a Question — Design

**Date:** 2026-08-16
**Status:** Approved
**Sub-project:** 4 of the 5-part roadmap

## Roadmap Context

Sub-project 1 shipped per-user Snowflake authentication and a query gateway
that builds all SQL server-side. 2a shipped the report canvas; 2b added
filters, hierarchies and drill-down. 3 added workspaces, so a report can be
shared while every viewer still queries on their own credentials.

4 adds the last thing the original brief asked of a report: *"they must be
able to ask questions on top of it using LLM."*

Sub-project 5 (Excel export) follows unchanged.

## The Blocker, Stated Up Front

**Cortex AI functions are not available on the development account.** Every
call returns:

    399258 (0A000): AI function COMPLETE is not available for trial accounts.

Account `RC16948` (`AZURE_CENTRALINDIA`) is a trial, and Snowflake gates the
whole Cortex LLM surface behind that. Semantic views are unaffected.

This sub-project is therefore built **behind a provider seam**. Everything
except the live model call is implemented and tested now; the feature reports
itself unavailable on this account, with the account's own error text, and
begins working the moment Cortex is enabled — with no code change.

A skipped integration test is not a passing one, and the docs say so rather
than implying coverage that does not exist.

## The Central Design Decision

**The model proposes a query. It never executes one, and it never sees data.**

The flow:

1. `require_access(report, need="viewer")` — sharing rules are unchanged.
2. `DESCRIBE SEMANTIC VIEW` on **the caller's own connection**, giving exactly
   the dimensions and metrics their Snowflake role can see.
3. Build a prompt from that field list, the report's current filters, and the
   question. **Field names and types only — never rows.**
4. Ask the model for a **JSON query spec**: dimensions, metrics, filters,
   orderBy, limit, and a one-line explanation. Same vocabulary
   `POST /api/query/semantic` already speaks.
5. Validate that spec against the live describe catalog. Unknown field,
   unknown operator, malformed JSON — all rejected.
6. Execute it through the existing `build_semantic_sql` + `run_query` path,
   with values bound as parameters, on the caller's own connection.

The model is a **query author**, not a query engine. Every guarantee the
product already has continues to hold because the model's output re-enters the
same validated path a human's clicks do.

### The Cortex call runs on the user's connection

`SNOWFLAKE.CORTEX.COMPLETE` is a SQL function, so it is invoked as

    SELECT SNOWFLAKE.CORTEX.COMPLETE(?, ?)

on `entry.conn` — the caller's own session. The LLM call is therefore
authorized by their Snowflake role and billed to their compute, exactly like
every other query this product runs. **There is no server-side API key
anywhere in this design**, and no data leaves Snowflake.

## Prompt Injection

The question is untrusted text entering a prompt. Prompt wording is not a
security control and this design does not pretend otherwise.

**The defence is structural.** The model's reply is parsed as JSON and
rejected unless every field it names exists in the catalog the caller's own
role can already see. So the worst a fully hijacked model can do is produce a
strange query over data the user could have queried by hand.

Specifically, it cannot:

- **emit SQL** — it returns a field list, never a statement;
- **reach another view** — the view is fixed by the report, not by the reply;
- **escalate** — execution uses the caller's connection and role;
- **exfiltrate** — it never receives a single row, only field names and types.

Tests assert this directly: a question instructing the model to ignore its
instructions and dump another table, with a `FakeProvider` returning exactly
that hostile spec, must be rejected by validation rather than executed.

Two further limits: the question is capped at 1,000 characters, and one
question makes exactly one model call — no agentic loop, no retry storm.

## The Query Spec

What the model must return, and what is validated:

```json
{
  "dimensions": ["CUSTOMERS.REGION"],
  "metrics": ["ORDERS.TOTAL_REVENUE"],
  "filters": [
    { "id": "q1", "field": "ORDERS.ORDER_DATE", "op": "relativeDate",
      "unit": "month", "count": 3 }
  ],
  "orderBy": [{ "field": "TOTAL_REVENUE", "direction": "desc" }],
  "limit": 20,
  "explanation": "Revenue by region over the last three months."
}
```

`filters` reuses the sub-project 2b discriminated union verbatim, so relative
dates still resolve server-side and values are still bound parameters. The
spec is parsed with `extra="forbid"`: a model that invents a `sql` key is
rejected, not partially honoured.

`explanation` is displayed to the user. It is **presentation only** and is
never parsed, executed, or trusted for any decision.

## Endpoint

`POST /api/reports/{report_id}/ask`, requiring `viewer`.

Request: `{"question": "..."}`

Response:

```json
{
  "explanation": "Revenue by region over the last three months.",
  "spec": { "dimensions": [...], "metrics": [...], "filters": [...] },
  "columns": [...],
  "rows": [...],
  "truncated": false,
  "sql": "SELECT * FROM SEMANTIC_VIEW(...)"
}
```

The `spec` and `sql` are returned deliberately. An answer you cannot audit is
an answer you should not act on, so the UI shows what was actually asked
alongside the number.

## Error Handling

| Condition | Code | Status |
|---|---|---|
| Cortex not enabled on the account | `CORTEX_UNAVAILABLE` | 503 |
| Model returned unparseable JSON | `ASK_FAILED` | 502 |
| Spec names a field the catalog lacks | `ASK_INVALID` | 400 |
| Question empty or over 1,000 chars | `HTTP_ERROR` | 422 |
| Report not visible to the caller | `HTTP_ERROR` | 404 |

`CORTEX_UNAVAILABLE` carries Snowflake's own message, so a user on a trial
account is told why rather than shown a generic failure. It is detected from
errno `399258` and from "not available for trial accounts" in the text —
the errno alone is the primary signal, with the text as a fallback in case
the code changes.

A rejected spec reports which field was not recognised. That is the most
common real failure — the model guessing a plausible column name — and naming
it lets the user rephrase.

## UI

An **Ask** panel in the builder, opened from the header, sitting alongside
Export and Import.

- A question box and a Send button. Enter submits; the box is never the only
  path.
- While waiting: a clearly labelled pending state naming the step, since a
  model call is slower than a query.
- The answer: the model's explanation, then the result rendered with the
  existing `AutoChart`/`ResultsTable` — a chart when the shape suits one,
  a table otherwise, decided by the code that already makes that decision.
- **The spec, shown plainly** beneath the answer: which fields, which filters.
- **Add as visual**, which appends the spec's fields to a new visual on the
  canvas. Editors only; a viewer can ask and read but not modify the report.
- When Cortex is unavailable, the panel says so with the account's message and
  the question box is disabled rather than absent — hiding it would make the
  feature look missing rather than unprovisioned.

Every existing constraint carries over: focus outlines are never removed, hit
targets clear 24px, chrome is never painted in a series colour, and the layout
holds at 1440 / 1280 / 1024 / 768 / 390px.

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `SEMANTICUI_CORTEX_MODEL` | `llama3.1-70b` | Which Cortex model to call |
| `SEMANTICUI_ASK_ENABLED` | `true` | Kill switch, so an operator can turn the feature off without a deploy |

No API keys, because there are none to configure.

## Testing

- **Provider seam:** `FakeProvider` drives every test, so the whole path is
  covered without Cortex.
- **Spec validation:** unknown field, unknown operator, malformed JSON, extra
  keys, empty spec, a spec naming a field from a different view.
- **Prompt injection:** a hostile question plus a `FakeProvider` returning the
  hostile spec it asks for; the request must be rejected by validation, and a
  second test asserts no SQL from the model's text ever reaches the cursor.
- **Unavailability:** a provider raising Snowflake's 399258 produces
  `CORTEX_UNAVAILABLE` with the account's own message, not a 500.
- **Access:** asking about a report in a workspace you do not belong to is
  404; a viewer may ask; only an editor may add the answer as a visual.
- **Credentials:** the Cortex call and the resulting query both run on the
  asking user's connection — asserted the same way sub-project 3 asserts it.
- **Frontend:** the panel disables itself with a stated reason when
  unavailable; the spec is displayed; Add as visual is hidden from viewers.
- **Integration:** a real question against the real account, which **skips**
  while Cortex is unavailable, with a reason naming the errno.

## Out of Scope

Multi-turn conversation and follow-up questions; saving questions with the
report; charts chosen by the model rather than by the existing chart-selection
code; questions spanning more than one semantic view; any external LLM
provider; text-to-SQL in the general sense — the model is confined to the
report's own bound view. Excel export remains sub-project 5.
