# Model trust and provenance — design

Date: 2026-08-22
Status: approved in conversation, ready for planning

## The problem

A report shows numbers. Nothing in the product says whether the model behind
those numbers is one the organisation stands behind, who owns it, or how old
its data is. A reader who wants to know has to go and ask somebody.

Two questions arrive together and are answered from the same place, which is
why this is one piece of work rather than two:

- **Is this model trustworthy?** Somebody with the authority to say so has
  looked at this semantic view and certified it, and there is a named owner
  to ask when it looks wrong.
- **Is this data current?** The report queries live, so the *query* is always
  fresh — but the tables underneath may have last loaded three days ago, and
  the product never says so.

Neither is decorative. A certification nobody can trace to an authority is
worth nothing, so this design spends most of its care on *who is allowed to
certify* rather than on how the badge looks.

## What already exists

`SHOW SEMANTIC VIEWS` and `DESCRIBE SEMANTIC VIEW` are already parsed in
`app/semantic/discovery.py`, and both already carry what this needs — the
parser simply discards it:

- `list_semantic_views` keeps `name`, `database`, `schema`, `comment`. The
  command also returns **`owner`** and **`owner_role_type`**.
- `describe_semantic_view` iterates `TABLE` rows and keeps only
  `object_name`, the *logical* table name. Those same rows carry
  **`BASE_TABLE_DATABASE_NAME`**, **`BASE_TABLE_SCHEMA_NAME`** and
  **`BASE_TABLE_NAME`** — the physical table — and **`DEFINITION`** for a
  logical table backed by a SQL query rather than by a table.

So no new Snowflake round trip is needed to learn who owns a view or what it
reads from. Two parser extensions and one new query cover the whole feature.

Everything else this leans on is in place: `current_session` and the per-user
connection cache, the audit trail and its enumeration test, workspace roles,
and the report page bar (`frontend/src/reports/PageBar.tsx`).

## Scope

In:

- A certification record per semantic view: certified or not, a business
  owner, a note, and who certified it under which Snowflake role.
- Authority to certify delegated to Snowflake, not decided by the app.
- A certified badge in the model picker and on the report's About page.
- Source freshness per base table, derived from documented columns.
- A virtual **About** page appended to every report in view mode, carrying
  model trust, freshness, and defined placeholders for lineage and open
  issues.

Out, deliberately:

- The lineage and open-issues *content*. Their sections render with their
  real shape and a stated placeholder; the data lands later. See "Deliberate
  placeholders".
- The About page in the report builder, in PDF, and in Excel export. View
  mode only.
- Dynamic-table refresh lag. See "Why not dynamic table refresh history".
- Certification of anything other than a semantic view.

## Who may certify

**Snowflake decides. The app does not.**

`SHOW SEMANTIC VIEWS` reports the role that owns the view. To certify, the
caller's session must hold that role's authority, and Snowflake will answer
that directly on the caller's own connection:

    SELECT IS_ROLE_IN_SESSION('<owner>')

TRUE when the active primary role or a secondary role inherits the named
role — which is precisely Snowflake's own ownership semantics. This keeps the
property the whole product rests on: the app never widens anybody's rights,
and it does not invent a governance permission of its own that somebody could
be granted from inside the app.

Three details the documentation forces:

1. `owner_role_type` may be `DATABASE_ROLE`, and `IS_ROLE_IN_SESSION` only
   answers for account roles. A database role requires
   `IS_DATABASE_ROLE_IN_SESSION` instead. Both branches are implemented; the
   role type chooses between them.
2. The function returns **NULL** for shared objects reached through a data
   sharing consumer account. NULL is read as "no". Only TRUE permits.
3. It reads the *currently* active roles, not every role activated during the
   session. That is the behaviour we want — a user who switches role loses
   the ability to certify in the same gesture that changes what data they can
   read.

**Fail closed.** If the owner cannot be read, if the role type is
unrecognised, or if the check errors, certification is refused. A trust
control that fails open is worse than no control.

The stored record keeps `certified_by_role` alongside the user, so a later
audit shows *whose authority* was used and not merely whose account.

## Where certification is stored

An application table, `model_certifications`, one row per semantic view:

| Column | Notes |
|---|---|
| `id` | surrogate key |
| `database`, `schema`, `name` | unique together; the view's identity |
| `certified` | bool |
| `certified_by_user_id` | FK to `users` |
| `certified_by_role` | the Snowflake role whose authority was used |
| `certified_at` | timestamp |
| `owner_name`, `owner_contact` | the business owner; free text |
| `note` | what this model is for, or why it is certified |

Rejected alternatives, and why:

- **A Snowflake object tag.** Certification would live on the object itself,
  every tool would see it, and it is the most consistent choice with the rest
  of the product. It also requires tag objects to exist and `APPLY TAG` to be
  granted, which means this app writing DDL into the customer's account — a
  harder thing to get through a security review than holding the flag
  ourselves. The row above carries exactly what a tag would carry, so moving
  later is a data migration rather than a redesign.
- **The view's `COMMENT`.** Free, but unstructured, and it clobbers whatever
  the modeller wrote there.

The listing endpoint joins this table so the model picker shows the badge
from one query for the whole page, not one per row — the constant-query
property `FEATURES.md` claims for every listing.

## Source freshness

`SYSTEM$LAST_CHANGE_COMMIT_TIME` is the only DML-exact signal Snowflake
offers, and it cannot be displayed. The documentation is explicit:

> Snowflake recommends using this value only as a change indicator and
> strongly discourages users from treating this value as a timestamp.

So freshness is derived from two documented columns of
`INFORMATION_SCHEMA.TABLES` instead:

- `LAST_ALTERED` — "last altered by a DML, DDL, or background metadata
  operation"
- `LAST_DDL` — "the last DDL operation performed on the table or view"

Comparing them separates a data change from a definition change:

| Condition | Shown |
|---|---|
| `LAST_ALTERED > LAST_DDL` | **Updated `<LAST_ALTERED>`** |
| `LAST_ALTERED == LAST_DDL` | No update recorded since the definition changed `<LAST_DDL>` |
| Row absent from the result | Not visible to your role |
| Logical table has `DEFINITION` | Derived from a query — no single source table |

One statement per distinct base-table database, selecting
`TABLE_SCHEMA, TABLE_NAME, LAST_ALTERED, LAST_DDL, IS_DYNAMIC, ROW_COUNT`
for the tables the view names. It runs on the caller's own connection, so
`INFORMATION_SCHEMA` filters it to what their role may see, and a table they
cannot see is simply absent — which is why "not visible to your role" is a
rendered state and not an error.

The headline is the **oldest** resolvable source, because a report is only as
current as its stalest input:

> Sources last updated 06:15 today

with the per-table breakdown beneath it, and an explicit note when some rows
could not be resolved, so the headline is never read as covering them.

**The honest caveat, which belongs in the UI copy and not only here:**
background maintenance such as auto-clustering also moves `LAST_ALTERED`, so
this can over-report freshness slightly. What it cannot do is report data as
fresh when only the definition changed, which is the failure the derivation
exists to avoid.

### Why not dynamic table refresh history

`DYNAMIC_TABLE_REFRESH_HISTORY` carries the ideal answer — `DATA_TIMESTAMP`,
the transactional timestamp that all included data arrived before, plus the
target lag. It requires the **MONITOR** privilege, which an analyst role will
not hold, so under per-user credentials it fails rather than degrades.
`IS_DYNAMIC` comes free in the row we already select, so v1 marks a dynamic
source and the operator documentation notes that granting MONITOR would buy a
better answer. That is a deployment decision, not a code one.

## The About page

**Virtual, not stored.** `ReportDefinition.pages` is a strict model whose
`kind` is `Literal["canvas", "sheet"]`, and report documents are byte-stable
across two exports of the same report. A generated page whose content changes
with the data would break that guarantee and force a migration of every
existing report. The About page is appended by the viewer; the definition is
untouched.

`PageBar.tsx` renders one extra tab after the real pages. It is not
reorderable, not deletable, and absent from the builder's page management.

Four blocks, in one round trip from `GET /api/reports/{id}/provenance`:

1. **Model** — view name, certified badge, business owner and contact, who
   certified it under which role and when, and the note.
2. **Source freshness** — the headline plus the per-table table above.
3. **Lineage** — placeholder.
4. **Open issues** — placeholder.

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/semantic-views/{db}/{schema}/{name}/certification` | Status, owner fields, and `canCertify` for the caller |
| `PUT` | `/api/semantic-views/{db}/{schema}/{name}/certification` | Set or clear; authority checked as above |
| `GET` | `/api/reports/{id}/provenance` | The four blocks for the About page |

`PUT` writes the whole record — the certified flag, the owner fields and the
note together — and the same authority governs all of it. Naming an owner is
as much a governance act as certifying, so it cannot be a weaker permission.
Clearing certification keeps the owner fields: an uncertified model still has
somebody to ask, and re-certifying should not mean retyping what was already
true.

`GET /api/semantic-views` gains a `certified` flag per row from the join.

`canCertify` costs one Snowflake round trip, so it is computed on the
single-view certification endpoint only — never per row of a listing.

Two new audit actions, `model.certify` and `model.uncertify`, recording the
view identity, the outcome, and the role whose authority was used — never the
note text. `test_app.py` enumerates the expected actions and fails if an
endpoint ships without one, so both must be registered there.

## Module boundaries

- `app/semantic/discovery.py` — extended to keep `owner`/`owner_role_type`
  from `SHOW`, and the `BASE_TABLE_*` and `DEFINITION` properties from
  `DESCRIBE`. Still a pure parser: no policy, no I/O of its own.
- `app/semantic/freshness.py` (new) — base-table list in, freshness rows out.
  Owns the `INFORMATION_SCHEMA` statement and the `LAST_ALTERED`/`LAST_DDL`
  derivation, and nothing else.
- `app/semantic/certification.py` (new) — the authority check and the record.
  The only module that knows `IS_ROLE_IN_SESSION` exists.
- `app/reports/provenance.py` (new) — assembles the four blocks. Composes the
  two modules above and contains no SQL of its own.
- `frontend/src/reports/AboutPage.tsx` (new) — presentational, fed by one
  query hook.

The split matters because freshness and certification fail independently: a
model can be certified while its freshness is unreadable, and the reverse,
and the page must render either way.

## Error and empty states

- **No certification record** — "Not certified", owner fields empty. Absence
  is a real answer here, not a missing one.
- **Owner role unreadable, or the authority check fails** — certification
  controls are hidden and the record is unchanged. The refusal is quiet to
  the reader and audited for the operator.
- **Freshness query fails entirely** — the block renders "Source freshness
  unavailable" with the request id. The rest of the page still renders.
- **Some tables unresolvable** — those rows say so individually, and the
  headline states that it covers only the resolved ones.
- **A model whose logical tables are all query-backed** — the freshness block
  says so once rather than listing four identical rows.

## Deliberate placeholders

Lineage and open issues render with their real structure and a stated
placeholder. This is a scope decision, not an unfinished section:

- **Lineage** — the section and its table shape exist; the content is
  placeholder text. An API to supply it is expected, and wiring it in should
  change neither the page's layout nor the provenance endpoint's shape.
- **Open issues** — the table's columns are defined and the empty state is
  the placeholder. The intended first signal is field drift: a visual, filter
  or hierarchy naming a dimension or metric the semantic view no longer has,
  which is diffable today between the report definition and `describe_view`
  with no new storage.

Both are shaped so that filling them is a data change rather than a redesign.

## Testing

Backend, TDD as usual:

- Parser: `SHOW` rows yield owner and owner role type; `DESCRIBE` TABLE rows
  yield the qualified base table; a `DEFINITION` row yields a query-backed
  logical table with no base table.
- Authority: an account-role owner routes to `IS_ROLE_IN_SESSION`, a database
  role to `IS_DATABASE_ROLE_IN_SESSION`, NULL is refused, an unreadable owner
  is refused, an errored check is refused. One test per refusal, because each
  is a distinct way to fail open.
- Freshness: every row of the derivation table above, including a table
  absent from the result and a whole-query failure.
- Certification endpoints: a permitted set, a refused set, and that a refusal
  leaves the record untouched.
- Audit: both new actions are written, and carry no note text.
- Listing: the certified flag costs no extra query per row.

Frontend:

- The About tab appears after the real pages, and is absent in the builder.
- Each rendered state above, including the mixed case where freshness
  resolves for some tables and not others.
- Rendering the page leaves the report definition unchanged — export before
  and after are identical.
