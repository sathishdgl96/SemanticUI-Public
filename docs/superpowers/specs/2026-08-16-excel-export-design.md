# Excel Export & Live Connection — Design

**Date:** 2026-08-16
**Status:** Approved
**Sub-project:** 5 of the 5-part roadmap, and the last item of the original brief

## Roadmap Context

Sub-projects 1–4 shipped authentication and a query gateway, the report canvas
and its portable JSON document, filters and drill-down, workspaces and
sharing, and question-answering behind a Cortex seam.

5 delivers the brief's remaining line: *"they must be able to export like
excel."*

Note that 2a already ships an **export** — a portable JSON definition for
moving a report between environments. That is a different job. This one is
the numbers, formatted, openable in Excel.

## Two Features, Not One

The user asked whether Excel could also connect **live**. It can, and the two
answers are different enough to state separately.

**A snapshot** (`.xlsx`) is what "export to Excel" normally means: the numbers
as they are now, in a file you can mail to someone.

**A live connection** is Excel refreshing from Snowflake itself, via its
native connector (*Data → Get Data → From Database → From Snowflake*). No data
passes through this application at refresh time, and the refresh authenticates
as the user, exactly like every other query here. We supply the SQL and the
connection details; Snowflake and Excel do the rest.

### What this sub-project deliberately does not build

**A refreshable URL served by this application.** Excel's refresh cannot carry
a session cookie, so such a URL would need a long-lived token — and a token
that returns data is a standing data-access grant that outlives the session,
works from anywhere, and belongs to whoever holds the link. Every other part
of this product refuses exactly that. It is out of scope, and this paragraph
exists so the refusal is a recorded decision rather than an oversight.

**A workbook with Power Query embedded**, refreshing on open. Real, but it
means hand-assembling OOXML parts that neither `openpyxl` nor `xlsxwriter` can
write, for a convenience the native connector already delivers in three
clicks.

## Snapshot Export

### The endpoint

`POST /api/reports/{report_id}/export.xlsx`, requiring `viewer`.

POST rather than GET because drill position and cross-filter selection live
only in the browser. The client sends, per visual, the **same resolved wells
and effective filters it already sends to `/api/query/semantic`**:

```json
{
  "sheets": [
    {
      "title": "Revenue by region",
      "dimensions": ["CUSTOMERS.REGION"],
      "metrics": ["ORDERS.TOTAL_REVENUE"],
      "filters": [ ... ],
      "orderBy": [ ... ],
      "context": "Drilled into US > California"
    }
  ]
}
```

Each entry is validated as a `SemanticQueryRequest` — the same identifier
checks, the same bound parameters, the same describe catalog — and run on the
caller's own connection. So "export what is on screen" needs no new state
anywhere: it is the queries already being displayed, run once more into a
workbook.

Response: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
with `Content-Disposition: attachment; filename="<report name>.xlsx"`.

### Workbook shape

A **Summary** sheet first: report name, the bound semantic view, who exported
it and when, and one row per data sheet naming its filters and any drill
context. A spreadsheet found in a shared drive six months later should be able
to explain itself.

Then one sheet per visual, named after the visual's title, with a bold header
row, frozen panes, and auto-sized columns.

Sheet names are sanitised: Excel forbids `[ ] : * ? / \`, caps names at 31
characters, and requires them to be unique. Collisions get a numeric suffix
rather than silently overwriting.

### Formula injection

**The one thing this feature would otherwise get wrong.**

A Snowflake value like `=cmd|'/c calc'!A0`, `+HYPERLINK(...)`, `-2+3` or
`@SUM(A1)` is treated as a *formula* by spreadsheet software. The data is not
ours — it is whatever is in the user's warehouse — and the file is opened by
someone else.

The workbook is created with `strings_to_formulas=False`, and every text value
is written with `write_string` rather than the type-guessing `write`. A string
cell in `.xlsx` carries an explicit type and is never evaluated, so the value
displays exactly as stored.

This is preferred over the common trick of prefixing an apostrophe, which
changes what the reader sees. A test writes each dangerous prefix and asserts
the cell round-trips as a string with its original text intact.

### Limits

| Limit | Value | Why |
|---|---|---|
| Rows per sheet | 100,000 | Excel's own ceiling is 1,048,576; this is generous and bounded. Truncation is stated on the Summary sheet, never silent. |
| Sheets per workbook | 50 | Matches `MAX_VISUALS`. |
| Query row cap | `export_row_cap`, default 100,000 | Separate from the 10,000 display cap: an export is meant to be complete, a screen is not. |

`xlsxwriter` runs in `constant_memory` mode, so memory stays flat regardless of
row count.

### Errors

Per-sheet failure does not lose the workbook. If one visual's query fails —
most likely `SNOWFLAKE_FORBIDDEN` on a field the viewer's role cannot read —
that sheet carries the error text instead of data, and the Summary sheet says
which sheets failed. A shared report exported by a colleague with narrower
permissions produces a partial workbook that explains itself, rather than a
500.

A request naming an unknown field still fails the whole export with
`QUERY_ERROR`, because that indicates a client bug rather than a permissions
difference.

## Live Connection

`GET /api/reports/{report_id}/connect`, requiring `viewer`, returns everything
needed to wire Excel up:

```json
{
  "account": "xriieim-eh01350",
  "database": "SEMANTIC_DEMO",
  "schema": "TPCH",
  "view": "TPCH_SALES_ANALYTICS",
  "sheets": [{ "title": "Revenue by region", "sql": "SELECT * FROM SEMANTIC_VIEW(...)" }]
}
```

### The SQL here is a different code path, on purpose

Power Query supplies no bind parameters, so a copyable statement must have its
values **inlined as literals**. This product otherwise never puts a value into
SQL text, and that rule is not being relaxed — a second, clearly separated
function produces the copyable form:

- It lives in `app/export/literals.py`, a module that never touches a cursor.
- It is never executed by this application. It is returned for display only.
- Values are escaped for Snowflake literals: single quotes doubled, dates
  emitted as `TO_DATE('YYYY-MM-DD')`, numbers unquoted.
- A test asserts the *executable* path still emits `?` placeholders, so the
  two cannot be confused by a later refactor.

Inlining is safe here in a way it would not be elsewhere: the statement is run
by the user, in their own Excel, under their own Snowflake role. Nothing they
can express in it exceeds what they could already do. The escaping exists so a
value containing a quote produces valid SQL, not to prevent an escalation that
was never available.

### The panel

A **Connect live** view listing each visual with its SQL, a copy button, and
the steps: *Data → Get Data → From Database → From Snowflake*, the account and
warehouse to enter, then paste. The account identifier is shown in the form
the connector expects.

## Frontend

- **Export to Excel** in the builder header, beside Export and Ask. It posts
  the current effective queries — including drill and cross-filter — and
  downloads the returned blob.
- Pending state names the work (*"Running each visual's query…"*), since an
  export runs one query per tile and is slower than a single fetch.
- **Connect live** opens the SQL panel described above.
- Both are available to `viewer`: exporting and copying SQL are reading.
- Every existing constraint carries over: focus outlines are never removed, hit
  targets clear 24px, chrome is never painted in a series colour, and the
  layout holds at 1440 / 1280 / 1024 / 768 / 390px.

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `SEMANTICUI_EXPORT_ROW_CAP` | `100000` | Rows per sheet before truncation is declared |

## Testing

- **Formula injection:** each of `=`, `+`, `-`, `@` written and read back as a
  string cell with its text intact.
- **Sheet naming:** forbidden characters stripped, 31-character cap, duplicate
  titles disambiguated rather than overwritten.
- **Workbook shape:** a Summary sheet exists, names the view and the filters,
  and declares truncation when it happens.
- **Partial failure:** one visual raising `SNOWFLAKE_FORBIDDEN` yields a
  workbook where that sheet carries the error and the others carry data.
- **Access:** exporting a report in a workspace you do not belong to is 404; a
  viewer may export.
- **Credentials:** every query runs on the caller's connection — asserted as in
  sub-project 3.
- **Literal SQL:** values escaped correctly, a quote-containing value produces
  valid SQL, and the executable builder still emits `?`.
- **Frontend:** the export button posts the effective filters including drill
  state; the connect panel shows one SQL block per visual.
- **Integration:** a real export against the real account, opened with
  `openpyxl` to confirm it is a readable workbook rather than merely bytes.

## Out of Scope

Refreshable URLs served by this application; embedded Power Query; CSV export;
charts drawn into the workbook (the numbers are the point, and Excel draws its
own better); scheduled or emailed exports; PDF. Sub-projects 1–4 are unchanged.
