# SemanticUI

PowerBI-style reporting on top of Snowflake semantic views. Every query runs
with the signed-in user's own Snowflake credentials - Snowflake RBAC is the
sole authority on data access.

Spec: docs/superpowers/specs/2026-08-14-foundation-auth-query-gateway-design.md

## Prerequisites

- Python 3.12+, Node 20+, Docker (for local Postgres)
- A Snowflake account with at least one semantic view

## Local development (dev auth mode - no security integration needed)

    docker compose up -d postgres
    cd backend
    python -m venv .venv
    .venv\Scripts\activate        # Windows (source .venv/bin/activate elsewhere)
    pip install -e ".[dev]"
    copy .env.example .env        # defaults are fine for dev mode
    alembic upgrade head
    uvicorn app.main:app --reload --port 8000

In a second terminal:

    cd frontend
    npm install
    npm run dev

Open http://localhost:5173, choose a sign-in method, and sign in with YOUR
Snowflake account/user. "External browser (SSO)" pops your default browser
once for Snowflake SSO/login - no OAuth security integration required for
local dev.

## Authentication

Two settings control what login options are available, and they are
**independent** of each other:

- `SEMANTICUI_AUTH_MODE` (`oauth` | `dev`, default `dev`) - whether the
  Snowflake OAuth routes (`/auth/login`, `/auth/callback`, the "Sign in with
  Snowflake" button) are live at all. The backend refuses to start with
  `AUTH_MODE=dev` in production (`SEMANTICUI_ENVIRONMENT=production`).
- `SEMANTICUI_DIRECT_LOGIN_METHODS` (a JSON list, default
  `["externalbrowser", "password", "keypair"]`) - which authenticators the
  `/auth/dev-login` endpoint accepts, independent of `AUTH_MODE`. In
  production, this list may contain **only** `"keypair"` - the backend
  refuses to start otherwise. `externalbrowser` and `password` are
  development-only. `keypair` is allowed at any time, in either auth mode,
  as long as it's in this list; it is the only direct-login method allowed
  to run against a production backend, alongside (or instead of) OAuth SSO.

  Example: `SEMANTICUI_DIRECT_LOGIN_METHODS=["keypair"]`

The login page (`/login`) reads `GET /api/config` (`authMode`,
`directLoginMethods`) and only renders the options the backend currently
allows.

### Key-pair (PEM) login, memory-only

`keypair` submits a private key PEM (and optional passphrase) to
`POST /auth/dev-login` over the request body (protect this with TLS in any
non-local deployment). The backend parses it, builds the Snowflake
connection, and then **drops the key material** - the PEM/passphrase are
never written to Postgres and never logged (the global validation-error
handler strips the raw `input` field from any 422 response so a PEM that
fails to parse can't leak back into the response body either). The frontend
mirrors this: on both login success and failure it clears the PEM/passphrase
out of component state so they don't linger in an unmasked textarea.

Because nothing is persisted, a key-pair session lives only in the backend's
in-memory connection cache for that process. **A backend restart forces
key-pair users (like all dev-mode users) to sign in again** - there is no
stored credential to rebuild the Snowflake connection from. This is
different from OAuth sessions, whose encrypted refresh token in Postgres
lets the backend silently rebuild the connection after a restart.

To use key-pair login, a user first registers their public key on their own
Snowflake user (this is a one-time, self-service setup step - it does not
require an OAuth security integration):

    openssl genrsa -out rsa_key.pem 2048
    openssl rsa -in rsa_key.pem -pubout -out rsa_key.pub

Then, in Snowflake, as (or on behalf of) that user:

    ALTER USER <u> SET RSA_PUBLIC_KEY='<base64 body of rsa_key.pub, without
    the -----BEGIN/END PUBLIC KEY----- lines and newlines>';

The private key (`rsa_key.pem`) never leaves the user's control except as
the TLS-protected body of the login request to this backend - SemanticUI
never stores it.

## Production (Snowflake built-in OAuth)

1. Create the security integration in Snowflake (ACCOUNTADMIN):

       CREATE SECURITY INTEGRATION semanticui_oauth
         TYPE = OAUTH
         OAUTH_CLIENT = CUSTOM
         OAUTH_CLIENT_TYPE = 'CONFIDENTIAL'
         OAUTH_REDIRECT_URI = 'https://<your-host>/auth/callback'
         OAUTH_ISSUE_REFRESH_TOKENS = TRUE
         OAUTH_REFRESH_TOKEN_VALIDITY = 7776000
         ENABLED = TRUE;

       SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('SEMANTICUI_OAUTH');

2. Configure the backend env:

       SEMANTICUI_AUTH_MODE=oauth
       SEMANTICUI_ENVIRONMENT=production
       SEMANTICUI_SECRET_KEY=<32+ bytes of entropy, from a secret store>
       SEMANTICUI_DATABASE_URL=postgresql+psycopg://...
       SEMANTICUI_SNOWFLAKE_ACCOUNT=<orgname-accountname>
       SEMANTICUI_OAUTH_CLIENT_ID=<from step 1>
       SEMANTICUI_OAUTH_CLIENT_SECRET=<from step 1>
       SEMANTICUI_OAUTH_REDIRECT_URI=https://<your-host>/auth/callback
       SEMANTICUI_DIRECT_LOGIN_METHODS=["keypair"]
       SEMANTICUI_POST_LOGIN_REDIRECT_URL=/

   `SEMANTICUI_DIRECT_LOGIN_METHODS` is optional but recommended if you
   also want to offer key-pair login alongside OAuth SSO in production;
   omit it entirely (or set `[]`) to make OAuth the only way in. Any value
   other than `[]` or `["keypair"]` is rejected at startup in production.
   `SEMANTICUI_POST_LOGIN_REDIRECT_URL` controls where `/auth/callback`
   sends the browser after login - see "Serving the SPA in production"
   below before changing it from the default `/`.

The backend refuses to start with `AUTH_MODE=dev` in production.

### Serving the SPA in production

**The backend does not serve the frontend.** `backend/app/main.py` mounts no
static files - it is an API-and-auth server only (`/auth/*`, `/api/*`,
`/healthz`). In local dev this is invisible because the Vite dev server
proxies `/api` and `/auth` through to the backend on your behalf; there is
no equivalent proxy in a production build, so an operator who only follows
the "Configure the backend env" steps above ends up with a backend that
answers API calls correctly but returns a JSON `404 {"code": "HTTP_ERROR",
...}` for `GET /` - and `/auth/callback`'s post-login redirect (default
target `/`) lands there too. Pick one of these two layouts:

1. **Reverse proxy serving both from one origin (recommended).** Point
   your proxy (nginx, Caddy, a cloud load balancer, etc.) at
   `frontend/dist` (the output of `cd frontend && npm run build`) for `/`,
   and proxy `/api/*` and `/auth/*` through to the backend process. Leave
   `SEMANTICUI_POST_LOGIN_REDIRECT_URL` at its default (`/`) - the OAuth
   callback's redirect then lands back on the SPA, on the same origin, with
   no CORS configuration needed anywhere.
2. **Frontend on a separate static host.** Deploy `frontend/dist` to a
   static host/CDN (S3+CloudFront, Netlify, Vercel static hosting, etc.)
   that is a different origin from the backend, and set
   `SEMANTICUI_POST_LOGIN_REDIRECT_URL=https://<your-frontend-host>/` so
   `/auth/callback` redirects the browser there instead of to the backend's
   own `/`. The frontend's `VITE_API_BASE_URL` (or equivalent build-time
   config) must then point at the backend's origin, and the backend's
   session cookie (`SameSite=Lax`, see `set_session_cookie` in
   `backend/app/auth/sessions.py`) works for this as long as the frontend
   navigates the browser to the backend for `/auth/login` (a top-level
   navigation, not a fetch/XHR) rather than trying to call it cross-origin.

Either way, this backend never renders HTML or ships JS/CSS itself -
`post_login_redirect_url` is the only knob it exposes for this; the actual
topology (single origin vs. split) is a deployment decision, not something
the app hardcodes.

## The explorer UI

After login, the explorer is three panes:

1. **Semantic view tree** (left) - every semantic view the signed-in user's
   own Snowflake role can see (this is enforced by Snowflake, not the app -
   the list comes from `SHOW SEMANTIC VIEWS` run on the user's own
   connection).
2. **Field list** (middle-top) - once a view is selected, its dimensions and
   metrics, each showing its Snowflake data type. Dimensions show a `⬦`
   glyph, metrics a `Σ` glyph.
3. **Field wells - Axis / Legend / Values** (middle-bottom) - drag a field
   from the field list into a well, or focus a field and press **Enter** to
   add it to its default well (Values for a metric; Axis first, then Legend,
   for dimensions). Press **Space** on a focused field to pick it up for a
   keyboard-only drag (arrow keys to move between wells, Space again to
   drop, Escape to cancel - dnd-kit's standard keyboard sensor behavior).

Wells are type-validated: **Axis** and **Legend** only accept dimensions,
**Values** only accepts metrics. Axis and Legend each hold at most one
field; Values holds any number. A drop (pointer or keyboard) of the wrong
field kind onto a well is refused - the field is not added, the well shows a
"blocked" state while a drag is in progress, and screen readers get an
explicit "not allowed" announcement (dnd-kit's default announcer is purely
geometric and doesn't know about this rule, so the app supplies its own).
Each field already in a well appears as a chip with its own **Remove**
button.

Setting a **Legend** splits a single measure into one chart series per
distinct legend value (a pivot done client-side over the query result).
Only the first selected metric is charted in that case - the app shows a
note explaining this - but the results table still shows every selected
field.

Pressing **Run** sends the well selections as a semantic query. The result
renders as: an auto-chosen chart (line, if the Axis dimension's type is
DATE/TIMESTAMP; otherwise bar with rounded tops; no chart unless exactly one
Axis dimension and at least one metric are selected), a results table, and a
"SQL sent" preview of the exact `SEMANTIC_VIEW(...)` SQL that ran.

## Reports

`/reports` lists the signed-in user's own saved reports (owned per user -
nobody sees anyone else's). **New report** creates a blank, unbound report
and opens it in the builder at `/reports/{id}`; the explorer's **Add to
report** button (top bar, enabled once a view is selected and the wells hold
a combination the resulting visual actually accepts - for the Bar visual it
seeds, that means at least one Axis dimension *and* at least one Values
metric; a hint next to the button explains this while it's disabled) does
the same but seeds it with a single Bar visual holding the wells you already
built - a one-click hand-off from ad hoc exploration to a saved report.

**Binding a view.** A fresh or orphaned report (its bound view renamed,
dropped, or no longer visible to your role) shows the same semantic-view
tree as the explorer; pick a view to bind the report to it. Only fields that
view exposes to your Snowflake role can be placed on a visual.

**Adding visuals and choosing a type.** The builder's right-hand
"Visualizations" pane picks a type and adds a visual to the canvas at a
default 6x6 layout. The type picker can also switch an existing selected
visual's type in place; fields that don't fit the new type's wells are
dropped and named in a one-line notice. Fields are placed either by
**clicking** a field in the "Fields" pane (adds to the first well of the
matching kind with room) or by **dragging** it onto a specific well - drag is
never the only way to place a field.

**The seven visual types and what each well takes:**

| Type | Wells |
| --- | --- |
| Bar | Axis (1 dimension), Legend (0-1 dimension), Values (1+ metrics) |
| Line | Axis (1 dimension), Legend (0-1 dimension), Values (1+ metrics) |
| Area | Axis (1 dimension), Legend (0-1 dimension), Values (1+ metrics) |
| Pie | Legend (1 dimension), Values (1 metric) |
| Scatter | X axis (1 metric), Y axis (1 metric), Detail (0-1 dimension) |
| Table | Dimensions (0+), Metrics (0+) - at least one field total |
| KPI card | Value (1 metric) |

Bar and Area also take a **stacked** option; Pie takes **donut**; KPI takes a
number **format** (plain or compact, e.g. "1,234,567" vs. "1.2M"). A field
may only occupy one well on a visual at a time.

**Canvas.** Tiles drag to reposition and resize on a 12-column grid; each
tile queries independently, so one tile's fields being invalid or its query
failing (e.g. a field your role can no longer see) shows that tile's own
error without affecting its neighbours, which keep rendering their own data.

**Saving.** The **Save** button is disabled until the report has unsaved
changes (a diff against the last loaded/saved definition) and re-disables
immediately after a successful save.

**Export and import.** **Export** shows the report's portable JSON
definition in a read-only, selectable/copyable text box (`GET
/api/reports/{id}/export`) - stable key order and formatting, so two exports
of an unchanged report are byte-identical. **Import** accepts that JSON back
(`POST /api/reports/import`) and always creates a **new** report, never
overwriting one that exists; an optional database/schema/view override lets
you retarget the imported report at a different semantic view (e.g. moving a
definition from a dev view to a prod one) before it's validated. Either way,
import re-validates **every field reference** in the definition against a
live DESCRIBE of the target view run on the importing user's own Snowflake
connection - a field the importer's role can't see, or that no longer
exists, is rejected with the offending reference named in the error, not
silently dropped.

**Report definitions are stored; query results never are.** Only the
JSON definition (view binding, visuals, wells, layout, options) is persisted
in Postgres. A shared or imported report always runs on the *viewer's own*
Snowflake credentials and role the moment they open it - the same "Snowflake
RBAC is the sole authority on data access" rule the explorer follows. Nothing
about report data itself is ever written to SemanticUI's own database.

## Filters, hierarchies and drill-down

### Filters

Filters live in the definition document at two scopes. **Report filters** sit
at the top level and apply to every visual; **visual filters** sit on the
visual they belong to. They compose by intersection - a visual's effective
filter set is report filters AND its own AND its drill path AND any active
cross-filter.

Four operators, each mapping to one bound-parameter predicate:

| `op` | Fields | Predicate |
|---|---|---|
| `is` | `values: string[]` | `field IN (?, ?)`; a single value emits `=` |
| `isNot` | `values: string[]` | `field NOT IN (?, ?)`; a single value emits `<>` |
| `between` | `from`, `to` | `field BETWEEN ? AND ?` |
| `relativeDate` | `unit`+`count`, or `preset` | resolved server-side to `field BETWEEN ? AND ?` |

**An unfinished filter means "not filtering yet", not "match nothing".** A
filter with no values chosen, or a `between` with an empty endpoint, is saved
in the document and skipped when building SQL (`is_active`, mirrored on both
sides of the wire). `IN ()` is neither valid SQL nor a valid request body;
before this rule existed, adding a filter and not immediately ticking a value
422'd every tile on the report.

### The security property

Every SQL statement this product builds uses only *identifiers*, each
validated against a live `DESCRIBE SEMANTIC VIEW` on the requesting user's own
connection and quoted by `quote_ident`. **Filters are the first feature where
user-supplied VALUES reach a query.**

The rule, which no part of the implementation may relax: **values are bound
parameters, never SQL text.** `backend/app/semantic/predicates.py` is the only
module that turns a filter into SQL, so that rule is checkable by reading one
file rather than auditing every call site. Values leave it in a `params` list;
only a placeholder and a catalog-derived identifier reach the statement.

Connections open with `paramstyle="qmark"` (`app/snowflake/connect.py`), which
binds server-side. The connector's default, `pyformat`, escapes and
interpolates client-side - it works, but it is strictly weaker than never
putting the value in the statement at all.

Related guarantees: operators come from a closed discriminated union, so an
unknown one is a rejection rather than a passthrough; relative dates resolve
server-side into bound `date` objects, so no date arithmetic is assembled from
user text; at most 500 values per filter, each at most 255 characters; and
cross-filter selections are subject to every rule above, being filters that
happen to originate from a click.

Proven two ways: a unit test asserts that `' OR 1=1 --` appears nowhere in the
generated SQL, and an integration test runs that same value against real
Snowflake and asserts it matches zero rows - which is only possible if it was
bound rather than interpolated.

### Filters are pushed *inside* `SEMANTIC_VIEW(...)`

The `WHERE` clause goes inside the call, after `METRICS`, not after the
closing paren. That is not a style choice: a KPI card showing total revenue
filtered to one region has no `REGION` column in its result to filter on
afterwards, so the predicate has to apply before aggregation.

Verified against a real account before any of this was built - see
`docs/superpowers/specs/2026-08-15-filter-spike-findings.md`, which also
records that a filtered dimension does *not* silently join the grouping, so a
filtered KPI stays a single number.

### Hierarchies and drill-down

A hierarchy is an ordered list of dimension references stored in the report:

    "hierarchies": [
      { "id": "h1", "name": "Geography",
        "levels": ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY"] }
    ]

A dimension well may hold `"hierarchy:h1"` in place of a field. The visual
renders the level it is currently on; clicking a mark drills - the clicked
value becomes a filter and the axis advances one level. A breadcrumb shows the
path, "Drill up" walks back, and Backspace on the focused tile does the same.
At least two levels are required: a one-level hierarchy is a plain field.

Import validates **every** level against the importer's own DESCRIBE, so a
level their role cannot see fails the import rather than lying dormant until
someone drills into it.

**Model-first detection ships but finds nothing today.** `detect_hierarchies`
reads hierarchy-shaped objects out of `DESCRIBE SEMANTIC VIEW` and returns
`[]` on every account tested, which is why reports define their own. The
detector exists so the model path activates by itself if an account ever
exposes them. `GET /api/semantic-views/{db}/{schema}/{name}` reports the
result as `modelHierarchies`, always present, empty when there are none.

### Cross-filtering

Clicking a mark on a non-drillable visual filters every *other* visual to that
value; clicking the same mark again clears it. A labelled chip above the
canvas says what is selected and offers a Clear control, so the state is never
invisible.

### Drill position and cross-filter selection are never persisted

Both live in React state and reset with the report id. A saved report always
opens at the top level with nothing selected, an export contains neither, and
a stored drill path can never point at a value that has since disappeared from
the view. `BuilderPage.test.tsx` asserts Save stays *disabled* after drilling
and cross-filtering, which is the real statement that they are view state
rather than document state.

### Schema version 2

Adding filters and hierarchies moved `SCHEMA_VERSION` to 2.
`migrate_definition` runs *before* validation and upgrades a v1 document by
adding the empty collections, so reports and exports saved before this change
keep opening forever. Anything above the current version is still rejected.

### Distinct values for the filter editor

`GET /api/semantic-views/{db}/{schema}/{name}/values?field=TABLE.FIELD` runs a
capped query on the caller's own connection through the same builder every
other query uses, so a user is only ever offered values their Snowflake role
can already read. Capped at 1000 with an explicit `truncated` flag; NULL is
dropped, because `IN (?)` never matches it and offering it would build a
filter that silently returns nothing.


## Workspaces and sharing

**Workspaces are the only unit of sharing.** A report lives in exactly one
workspace, and membership of that workspace is the only thing that grants
anyone access to it. There is no second, unfiled access path, so "why can this
person see this?" has exactly one answer.

Every user gets a **personal workspace** on first login, called "My reports".
It refuses members, renames and deletion - that is what makes it personal, and
it is enforced server-side rather than by hiding a button.

### Roles

| Role | May |
|---|---|
| `viewer` | Open and export reports |
| `editor` | Also create, edit, delete and move them |
| `admin` | Also manage membership, rename and delete the workspace |

These control who may change a report *definition*. They have nothing to do
with who may see *data* - that is Snowflake's business, below.

The ladder lives in one place (`app/workspaces/roles.py`) and fails closed: an
unrecognised role ranks below everything, rather than sorting above `admin` the
way a naive string comparison would.

### Sharing shares definitions. It never shares data.

This is the property the whole feature exists to preserve, and it is worth
being blunt about.

Every query runs on `entry.conn` - the connection belonging to the *requesting*
session, from that user's own Snowflake login. There is no service account, no
stored result set, and the per-session describe cache lives inside each
session's `CacheEntry` rather than in a process global.

So a viewer opening a shared report runs its queries **as themselves**. If
their Snowflake role cannot read the underlying view, the tiles fail with
`SNOWFLAKE_FORBIDDEN` and they see the report's shape and none of its numbers.
That is the correct outcome, not a bug to work around: adding someone to a
workspace grants them a definition, never a row.

`backend/tests/test_sharing_uses_viewer_credentials.py` asserts it directly -
two members, one workspace, one connection stubbed to refuse SELECT - and
asserts the *positive* case in the same fixture, so "no data" cannot be
mistaken for "nothing works".

### 404 versus 403

A **non-member** gets **404**, so they cannot tell "does not exist" from
"exists and is not yours". A **member with too low a role** gets **403**,
because they already know it exists and a 404 there would be a lie that helps
nobody. Both decisions are made in one function, `require_access` in
`app/workspaces/access.py`, which is the only place authorization is decided.

### Guard rails

Each is a server-side rule, not a UI affordance:

1. **The last admin cannot be removed or demoted**, including by themselves.
   A workspace with no admin can never have its membership changed again.
2. **A personal workspace refuses members, renames and deletion.**
3. **Membership is confined to one Snowflake account.** Adding a user from
   another account is rejected: their credentials could never resolve the
   workspace's views, so the grant would be an illusion of access.
4. **Moving a report needs editor on both source and destination.** Either
   half alone is a hole.
5. **Deleting a workspace deletes its reports**, explicitly rather than by
   `ondelete=CASCADE`, because SQLite does not enforce foreign keys by default
   and the Postgres cascade would leave orphans in dev.

### Adding a member

By Snowflake username, within your own account. Their `users` row is created
on demand - requiring a colleague to log in before you may share with them
makes sharing useless for onboarding. Listing members needs only `viewer`:
knowing who your work is visible to is not a privileged question.

### Migration to schema 0003

`alembic upgrade head` creates `workspaces` and `workspace_members`, adds
`reports.workspace_id`, and moves every existing report into its owner's new
personal workspace with that owner as admin. `owner_user_id` remains as
provenance - who created a report - and is never consulted for access.

Users who own no reports get their personal workspace lazily on next login,
so the migration does not manufacture one for someone who may never sign in.


## Asking a report a question

`POST /api/reports/{id}/ask` takes a plain-language question and answers it
with numbers from the report's own semantic view.

### The model proposes a query. It never executes one, and it never sees data.

The flow is:

1. `require_access(report, need="viewer")` - asking is reading, and sharing
   rules are unchanged.
2. `DESCRIBE SEMANTIC VIEW` on the caller's own connection, giving exactly the
   fields their Snowflake role can see.
3. A prompt built from **field names and types only** - never rows.
4. The model returns a **JSON query spec**: dimensions, metrics, filters,
   orderBy, limit, and a one-line explanation. The same vocabulary
   `POST /api/query/semantic` already speaks.
5. Every field in that spec is checked against the live catalog.
6. Execution through the existing `build_semantic_sql` + bound-parameter path,
   on the caller's own connection.

The model is a query *author*, not a query engine. Its output re-enters the
same validated path a human's clicks do, so every guarantee the product
already had continues to hold.

### The Cortex call runs on your connection

`SNOWFLAKE.CORTEX.COMPLETE` is a SQL function, so it is called on `entry.conn`
with the prompt as a **bound parameter**. The model call is authorized by your
Snowflake role and billed to your compute, exactly like every other query.
**There is no server-side API key in this design**, and no data leaves
Snowflake.

### Prompt injection

The question is untrusted text entering a prompt. **Prompt wording is not a
security control and this design does not pretend otherwise.**

The defence is structural: the model's reply is parsed as JSON and rejected
unless every field it names exists in the catalog your own role can already
see. So the worst a fully hijacked model can do is produce a strange query
over data you could have queried by hand. It cannot emit SQL (it returns a
field list), cannot reach another view (the view is fixed by the report),
cannot escalate (execution uses your connection), and cannot exfiltrate (it
never receives a row).

`extra="forbid"` on the spec means a model inventing a `sql` key is refused
outright rather than partially honoured. `explanation` is displayed and
**never parsed** - it is allowed to contain anything, because it reaches no
interpreter.

This is defence in depth rather than a single gate: `build_semantic_sql`
resolves every field against the same DESCRIBE and rejects an unknown one
independently. `test_the_query_builder_rejects_it_independently` asserts that,
so the redundancy is deliberate rather than an accident someone refactors away.

### Errors

| Condition | Code | Status |
|---|---|---|
| Cortex not enabled on the account | `CORTEX_UNAVAILABLE` | 503 |
| Model returned unparseable JSON, or invented a key | `ASK_FAILED` | 502 |
| Spec names a field the catalog lacks | `ASK_INVALID` | 400 |
| Question empty or over 1,000 characters | `HTTP_ERROR` | 422 |
| Report not visible to the caller | `HTTP_ERROR` | 404 |

`ASK_INVALID` names the offending field, because the most common real failure
is the model guessing a plausible column name and the fix is to rephrase.

### Cortex is unavailable on a trial account

    399258 (0A000): AI function COMPLETE is not available for trial accounts.

The whole Cortex LLM surface is gated behind a paid account. The feature is
built behind a provider seam and reports this with Snowflake's own wording, so
a user learns *why* rather than seeing a generic failure. Everything except
the live model call is implemented and tested; it starts working the moment
Cortex is enabled, with no code change.

`backend/tests/integration/test_ask_it.py` records the account's actual
capability on every integration run, and its end-to-end question test skips
behind `SEMANTICUI_IT_CORTEX=1`. **A skipped test is not a passing one** - see
`docs/superpowers/manual-passes/2026-08-16-ask.md` for what has and has not
been exercised.

### Settings

| Setting | Default | Purpose |
|---|---|---|
| `SEMANTICUI_CORTEX_MODEL` | `llama3.1-70b` | Which Cortex model answers |
| `SEMANTICUI_ASK_ENABLED` | `true` | Kill switch, no deploy needed |


## Excel export and live connection

Two different things, and the difference matters.

### The snapshot

**Export to Excel** in the builder downloads an `.xlsx` of what is currently on
screen. It is a POST, because drill position and cross-filter live only in the
browser: the client sends, per visual, the same resolved wells and effective
filters it already sends to `/api/query/semantic`, and the server validates and
runs each one on **your own connection**. So an export can never quietly
disagree with the screen it was taken from.

The workbook has a **Summary** sheet first - report name, semantic view, who
exported it and when, and one row per data sheet naming its filters and any
drill context. A spreadsheet found in a shared drive six months later should be
able to explain itself. Then one sheet per visual, with a bold frozen header
row.

### Formula injection

**A value from your warehouse beginning `=`, `+`, `-` or `@` is a formula to
whoever opens the file.** `=cmd|'/c calc'!A0` is the classic; `+HYPERLINK(...)`
and `-2+3+cmd|...` work the same way.

Every text cell is written with `write_string`, and the workbook sets
`strings_to_formulas=False`. A string cell in `.xlsx` carries an explicit type
and is never evaluated, so the value displays exactly as stored. This is
preferred over the common trick of prefixing an apostrophe, which changes what
the reader sees.

A negative *number* stays a number - `-5` begins with a dangerous prefix, and
writing it as text would break every sum in the sheet, so the type check comes
before the prefix check.

The tests read the generated file back with **openpyxl**, a different library
from the one that wrote it, and assert the cell type and the unchanged text.

### Limits and partial failure

100,000 rows per sheet, 50 sheets, `SEMANTICUI_EXPORT_ROW_CAP` (default
100,000) on the query. Truncation is declared on the Summary sheet, never
silent.

**A per-sheet failure keeps the workbook.** If one visual's query fails -
most likely `SNOWFLAKE_FORBIDDEN` on a field your role cannot read - that sheet
carries the error and the Summary says which failed. A shared report exported
by a colleague with narrower permissions produces a partial workbook that
explains itself, rather than a 500. An unknown *field* still fails the whole
export, because that indicates a client bug rather than a permissions
difference.

### Connecting Excel live

**Connect live** gives you what Snowflake's own Excel connector needs:

1. In Excel: Data → Get Data → From Database → From Snowflake.
2. Server: the panel shows it, in the form `ORG-ACCOUNT.snowflakecomputing.com`.
3. Sign in with your own Snowflake credentials.
4. Advanced options → paste one of the statements shown.

The workbook then refreshes straight from Snowflake **as you**. No data passes
through this application once connected, and there is no token anywhere.

The account identifier is read from `CURRENT_ORGANIZATION_NAME()` and
`CURRENT_ACCOUNT_NAME()` on your connection, not from `CURRENT_ACCOUNT()`.
The latter returns the account *locator*, which only resolves as a hostname in
Snowflake's default region - handing it to Excel gives a server string that
simply fails outside that region.

### Why the copyable SQL is a separate code path

Power Query supplies no bind parameters, so the statement it receives must have
its values **inlined as literals**. Every statement this application *executes*
binds its values instead, and that rule is not relaxed.

`app/export/literals.py` produces the copyable form. It imports no cursor, no
connection and no gateway - `test_the_literals_module_imports_nothing_that_can_execute`
parses its imports and asserts so - and nothing in this application ever runs
what it returns. A second test asserts `build_semantic_sql` still emits `?`, so
the two paths cannot be merged by a later refactor.

Inlining is safe there in a way it would not be elsewhere: the statement runs in
your Excel, under your Snowflake role, expressing nothing you could not already
do by hand. The escaping (single quotes doubled, dates as `TO_DATE(...)`) exists
so a value containing a quote produces *valid* SQL, not to prevent an escalation
that was never available.

### What is deliberately not built

**A refreshable URL served by this application.** Excel's refresh cannot carry
a session cookie, so such a URL would need a long-lived token - and a token that
returns data is a standing data-access grant that outlives your session, works
from anywhere, and belongs to whoever holds the link. Every other part of this
product refuses exactly that, so this one does too. Snowflake's own connector
achieves the same result without it.


## The PowerBI-style UI

The app is framed by a PowerBI-like shell: a near-black top bar with the
brand mark and your identity (Log out lives here), and a left nav rail --
Home, Explore, and a Workspaces flyout listing every workspace with your
role. The active surface carries the brand-yellow indicator.

The report list is the **workspace content page**: the workspace name as the
title, a toolbar (New report, Import, Explore, Members), and a content table.
Selection rides in the URL as `?workspace=<id>`, so the rail flyout and the
page share one source of truth and a workspace view is linkable.

The builder is the PowerBI editing surface: a ribbon-style command bar, a
gray canvas with white shadowed tiles and a Page 1 bar, and the tri-pane --
**Filters** (filter cards per scope), **Visualizations** (the visual gallery
and field wells), and **Data** (fields grouped by table, with search and
PowerBI checkbox semantics: checking a field adds it to the selected visual,
or creates a visual if none is selected; unchecking removes it). Each pane
collapses to a labeled strip.

Chart colors still come only from `src/query/palette.ts`; the brand yellow
(#f2c811) is chrome, never a series color.


## Tests

    cd backend && .venv\Scripts\python.exe -m pytest -v     # unit tests (no Snowflake needed)
    .venv\Scripts\python.exe -m pytest -m integration -v    # real-account tests
    cd frontend && npm test                                  # frontend tests
    cd frontend && npm run typecheck                         # TypeScript, no emit

(On macOS/Linux, drop the `.venv\Scripts\` prefix and just use `pytest` /
`python -m pytest` from an activated venv.)

Integration tests live in `backend/tests/integration/test_snowflake_it.py`
and are marked `@pytest.mark.integration`. `pyproject.toml` sets
`addopts = "-m 'not integration'"`, so a plain `pytest` run never touches a
real Snowflake account. To run them, set:

    SEMANTICUI_IT_ACCOUNT, SEMANTICUI_IT_USER, SEMANTICUI_IT_PASSWORD
    # optional: SEMANTICUI_IT_DATABASE, SEMANTICUI_IT_SCHEMA, SEMANTICUI_IT_VIEW

then run `pytest -m integration -v`. With `SEMANTICUI_IT_ACCOUNT` unset, every
integration test is cleanly **skipped** (not errored, not failed) via each
module's own `skipif`. A skipped integration suite is not a passed one - if
you are relying on it to prove something, check that it actually ran.

`backend/tests/integration/conftest.py` exports the `SEMANTICUI_IT_*` keys
from `backend/.env` into the environment, since these modules read
`os.environ` directly. Only those keys: a blanket `load_dotenv` would also
push `SECRET_KEY` and `AUTH_MODE` into every *unit* test in the same session,
because conftest module code runs at import.

`test_filter_spike_it.py` is not a regression suite. It records the four
Snowflake syntax questions sub-project 2b was built on - whether
`SEMANTIC_VIEW()` takes a `WHERE`, whether binds work inside it, whether a
filtered dimension may be unselected, and the clause order. Run it with `-s`;
the printed output is the deliverable. Findings are written up in
`docs/superpowers/specs/2026-08-15-filter-spike-findings.md`.

`backend/tests/integration/test_reports_it.py` covers the report side: it
signs in with the connector directly (same pattern as
`test_snowflake_it.py`), builds a definition from a real view's own first
dimension and metric, runs it through `import_report` - which re-validates
every field against a live DESCRIBE - and asserts the stored definition
round-trips byte-for-byte through `to_export_document`. This is the test
that would catch a DESCRIBE-shape change silently breaking import.

## Manual smoke test checklist

The automated suites above don't touch a real Snowflake account or a real
browser. Before shipping a change that touches auth or the explorer, walk
through this checklist by hand with backend + frontend running and Postgres
up.

**Drive it against the live API, not a stubbed one.** A browser pass with
`/api/*` stubbed exercises component wiring, routing and rendering, but proves
nothing about whether the request bodies the frontend sends are ones the real
server accepts. That gap is not hypothetical: it is how the 2a "New report"
bug reached a user past 266 green tests, and how sub-project 2b's unfinished-
filter 422 survived 472 green tests until an unstubbed pass found it in
minutes. Past passes are recorded in `docs/superpowers/manual-passes/`.

1. Open http://localhost:5173 -> redirected to the login page.
2. Dev-login with external browser -> browser pops once -> lands on the
   explorer.
3. The tree shows only semantic views YOUR user can see.
4. Select a view -> dimensions and metrics appear with data types.
5. Drag a date dimension onto **Axis**, drag a metric onto **Values** ->
   both appear as chips.
6. Try dragging a metric onto **Axis** -> confirm it is refused (no chip
   appears in Axis, the well shows a blocked state while dragging).
7. Press **Run** -> line chart + results table + "SQL sent" preview appear.
8. Remove the Axis chip via its **Remove** button, drag a text dimension
   onto Axis instead -> Run -> bar chart with rounded tops.
9. Drag a second dimension onto **Legend** -> Run -> chart splits into one
   series per legend value; if more than one metric is also selected, note
   only the first is charted and the table still shows every field.
10. Select 2 dimensions (Axis + Legend) with no metric, or 2+ metrics with
    no Axis -> Run -> table only, no chart.
11. Eyeball the chart: no label collisions, axis text is muted gray (not
    series-colored), a tooltip appears on hover.
12. Log out -> back to the login page; `/api/me` now returns 401.
13. Sign in again, this time with **Key pair (PEM)**: paste a private key
    whose matching public key has been registered on the Snowflake user
    (`ALTER USER <u> SET RSA_PUBLIC_KEY='...'`) -> lands on the explorer.
    Confirm the PEM textarea is empty again immediately after submit (key
    material is dropped from the frontend, not just the backend).
14. Restart the backend process, then reload the page -> the explorer's
    call to list semantic views now 401s (no cached connection to resume a
    dev-mode session from, key-pair included) and you're bounced to the
    login page -> log in again.
15. **Report round trip.** From `/reports`, click **New report** -> lands in
    the builder -> bind it to a semantic view. Add two visuals of different
    types (e.g. Bar and Table) and place fields on each by clicking (not just
    dragging). Drag one tile to a new grid position. Click **Save** (enabled
    only once something changed) -> reload the page -> the report reopens
    with both visuals, their fields, and the dragged tile's new position
    intact. Click **Export**, select and copy the JSON shown. From `/reports`,
    click **Import**, paste that JSON, and submit with no view override ->
    a second report is created -> open it and confirm it renders identically
    to the original (same visuals, same fields, same layout).

Fix anything that fails before committing.

16. Add a report-scope filter and tick two values -> every tile requeries and
    narrows.
17. Add a filter and *do not* choose a value -> tiles keep rendering, no 422.
18. Add a visual-scope filter on one tile -> only that tile changes.
19. Filter a **KPI card** by a dimension it does not display -> the number
    changes and no error appears. (This is the spike's Q3 in the product.)
20. Define a two-level hierarchy, place it on a bar's Axis, click a bar ->
    the axis advances and a breadcrumb appears.
21. Drill up with the control, then again with Backspace -> back to the top.
22. Click a mark on a non-hierarchy visual -> siblings filter, the source does
    not, and the "Filtered by" chip appears. Clear it -> everything returns.
23. Save and reload -> filters and hierarchies persist; drill position and
    cross-filter selection do **not**.
24. Export, then import -> filters and hierarchies survive the round trip.
25. Open a report saved *before* this branch -> it still opens (v1 migration).
26. Resize to 1440 / 1280 / 1024 / 768 / 390px -> the Filters pane stays
    usable and nothing overflows horizontally.

> **Note on this checklist.** Items 1-14 (auth/explorer) are written to be
> followed by a human and have not been re-executed against a live account as
> part of the most recent change.
>
> Item 15 (report round trip, sub-project 2a) was driven in a real Chromium
> browser but **with the network layer stubbed** (Playwright `page.route()`
> faking `/api/*`). That kind of pass exercises component wiring, routing and
> rendering for real, and it did catch a genuine layout bug - below 960px a
> chart tile's height resolved to 0 through a `height: 100%` chain whose
> ancestor was `auto`, leaving every chart blank on narrow screens even though
> the query had succeeded (`.tile-body`/`.auto-chart` now use flex sizing).
> **It does not verify that the request bodies the frontend sends are ones the
> real API accepts**, because the stub answers whatever the script tells it to.
>
> Sub-project 2b (filters, hierarchies, drill-down) was driven **unstubbed**
> against the real backend and real Snowflake - see
> `docs/superpowers/manual-passes/2026-08-16-filters-drilldown.md`. That pass
> immediately found a contract bug no stubbed test could: adding a filter and
> not yet choosing a value sent `values: []`, which the request model rejected,
> 422-ing every tile on the report and making it unsavable. 472 automated tests
> passed over it, because every one of them stubbed the endpoint doing the
> rejecting. It also records what it did *not* cover - clicking through a drill
> and cross-filtering two tiles in the browser are covered by unit tests only.
>
> Everything else in this README - config keys, validator behaviour, endpoint
> names, component and interaction behaviour - was verified directly against
> the source in `backend/app` and `frontend/src`.
