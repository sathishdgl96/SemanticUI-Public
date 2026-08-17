# SemanticUI

PowerBI-style reporting on top of Snowflake semantic views. Every query runs
with the signed-in user's own Snowflake credentials - Snowflake RBAC is the
sole authority on data access.

Spec: docs/superpowers/specs/2026-08-14-foundation-auth-query-gateway-design.md

## Quick start

Two commands, from a fresh clone:

    python dev.py setup      # Postgres, virtualenv, dependencies, .env, migrations
    python dev.py run        # both servers, one terminal, Ctrl-C stops both

Then open the URL it prints and sign in with your own Snowflake account.

`dev.py` needs nothing but a Python interpreter — no dependencies outside the
standard library, because it has to run *before* the virtualenv it creates
exists. Everything it does is idempotent, and it never overwrites a `.env` you
have edited.

| Command | Does |
|---|---|
| `python dev.py setup` | Checks versions, starts Postgres, creates the venv, installs both halves, copies `.env.example`, runs migrations |
| `python dev.py run` | Starts backend and frontend together, tags each log line `[api]` / `[web]`, stops both on Ctrl-C |
| `python dev.py test` | Backend tests, frontend tests, typecheck |
| `python dev.py doctor` | Versions, what this clone is missing, which ports are held |

**`run` picks its own ports.** It binds before choosing, so a port held by an
orphaned socket is stepped around rather than crashed into, and it passes the
backend's real port to Vite as `SEMANTICUI_API_TARGET` — which has to be
settled before Vite starts, since the proxy target is read once. That is the
single most common way to lose an hour on this project, so it is automated
rather than documented.

Fixed ports if you want them:

    python dev.py run --backend-port 8000 --frontend-port 5173

The manual steps are below, and remain the reference — `dev.py` runs exactly
them, and reading it is a faster way to see what setup involves than reading
this section.

## Setting up by hand

### What you need first

| | Version | Why that floor |
|---|---|---|
| Python | **3.12+** | `backend/pyproject.toml` sets `requires-python = ">=3.12"`. Developed on 3.14. |
| Node | **20.19+ or 22.12+** | Vite 8's own floor. Developed on 22.17. |
| Docker | any recent | Only to run Postgres locally. Skip it if you already have a Postgres 16. |
| Snowflake | an account | With **at least one semantic view** your role can see, and a way to sign in (SSO, password, or a registered key pair). |

The Snowflake account is not optional and not stubbable. This product has no
data of its own: every screen is a query run on your own credentials, so with
no semantic view visible to your role, the app signs you in and shows an empty
view tree. Check with `SHOW SEMANTIC VIEWS;` in a Snowflake worksheet before
blaming the setup.

### 1. Clone and start Postgres

    git clone <this repo> SemanticUI
    cd SemanticUI
    docker compose up -d postgres

That brings up Postgres 16 on **localhost:5432** with user/password/database
all `semanticui` — matching the connection string in `.env.example`. Postgres
stores sessions, workspaces, report and explore definitions. It never stores
query results.

Using your own Postgres instead? Create a database and set
`SEMANTICUI_DATABASE_URL` in step 2 to point at it.

### 2. Backend

    cd backend
    python -m venv .venv
    .venv\Scripts\activate            # Windows
    source .venv/bin/activate         # macOS / Linux
    pip install -e ".[dev]"
    copy .env.example .env            # Windows; `cp` elsewhere
    alembic upgrade head
    uvicorn app.main:app --reload --port 8000

`.env.example` is complete for local development — dev auth mode, the Docker
Postgres URL, and a placeholder secret key. The minimum-length and
not-the-default checks on `SEMANTICUI_SECRET_KEY` apply **only** when
`SEMANTICUI_ENVIRONMENT=production`, so the placeholder starts fine here and
will refuse to start there. `.[dev]` adds pytest and openpyxl; without it the
test suite cannot run.

`alembic upgrade head` creates every table from scratch (four migrations:
initial, reports, workspaces, saved explores). It is safe to re-run.

Check it came up:

    curl http://localhost:8000/healthz

### 3. Frontend

In a second terminal:

    cd frontend
    npm install
    npm run dev

Open **http://localhost:5173** and sign in with *your* Snowflake account and
user. "External browser (SSO)" pops your default browser once — no OAuth
security integration is needed for local development.

The dev server proxies `/api` and `/auth` to `http://localhost:8000`. To point
it somewhere else — a second backend on another port, say — set
`SEMANTICUI_API_TARGET` **before starting Vite**, since the proxy target is
read once at startup:

    SEMANTICUI_API_TARGET=http://localhost:8010 npm run dev

### 4. Confirm the install

    cd backend  && .venv/Scripts/python.exe -m pytest -q   # 647 tests, no Snowflake needed
    cd frontend && npm test                                 # 452 tests
    cd frontend && npm run typecheck                        # tsc -b
    cd frontend && npm run build                            # production bundle into dist/
    cd frontend && npm run lint                             # oxlint

Or all of the first three at once with `python dev.py test`.

All of these run without a Snowflake account. If they pass and the app still
misbehaves, the problem is your account or your semantic view, not the build.

### Credentials never enter the repository

`backend/.env` is gitignored and has never been committed. It is the only
file that holds anything sensitive, and `dev.py setup` creates it by copying
`.env.example` rather than by generating anything.

Verified across the whole history, not just the working tree: the Snowflake
password, `SEMANTICUI_SECRET_KEY`, the database URL and the integration-test
username appear in no commit, and there is no private key, AWS key or API
token anywhere in it either.

What *is* committed is object names — a database, a schema, a view — in the
docs and manual passes that record real runs. Those are not secrets. Tests use
a fictional account identifier (`acmeorg-wh12345`); a real tenant's has no
business being baked into one.

If you fork this or push it anywhere, check your own `.env` is still ignored
before the first push:

    git check-ignore -v backend/.env    # should print the .gitignore rule

### Troubleshooting a fresh setup

**`uvicorn --reload` stops noticing changes.** Seen repeatedly on Windows: the
process keeps serving code from when it started, and the symptoms look like
frontend bugs — a new field missing from a response, a new operator 422-ing, a
new route 404-ing. Check the process start time against when you edited the
file, and restart it. Before assuming a client bug, confirm the server is
running the code you just wrote.

**A killed server leaves its port occupied.** Also Windows: after killing
uvicorn, the socket can stay `LISTENING` against a PID that no longer exists,
and rebinding fails with `[Errno 10048]` *after* the log has already printed
"Application startup complete". Confirm with
`netstat -ano | findstr :8000` that the PID is the one you just started; if the
port is stuck, use another and point Vite at it with `SEMANTICUI_API_TARGET`.

**The view tree is empty after signing in.** The list comes from `SHOW
SEMANTIC VIEWS` run on *your* connection — the app never filters it. An empty
tree means your Snowflake role sees no semantic views.

**Postgres refuses the connection.** `docker compose ps` should show the
container up and 5432 published. On a machine already running Postgres, the
port is taken; change the host side of the mapping in `docker-compose.yml` and
`SEMANTICUI_DATABASE_URL` together.

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

After login, the explorer is shaped like Looker's: **two** columns, not three.

**Left — the sidebar**, hard against the edge, holding three labelled and
sticky sections: **Views** (every semantic view the signed-in user's own
Snowflake role can see — the list comes from `SHOW SEMANTIC VIEWS` run on
their own connection, so Snowflake enforces it, not the app), **Saved
explores**, and **Fields** (dimensions with a `⬦` glyph, metrics with `Σ`,
each showing its Snowflake data type).

**Right — a stack of foldable sections:** the selected fields, then Filters,
Visualization and Data.

**Selecting fields.** Click a field to add it, or drag it onto a well. The
wells are **Group by** (any number of dimensions), **Split by** (one optional
dimension, which splits a measure into one series per value) and **Measures**.
Enter adds a focused field to its default well; Space picks it up for a
keyboard-only drag. A drop of the wrong kind is refused, and screen readers
get an explicit "not allowed" announcement.

**Fields the current selection has ruled out are dimmed**, with one note
saying why. This is Snowflake's own grain rule, not a preference: a measure
defined at customer grain cannot be broken down by an order-level dimension,
and the join graph decides what is reachable. See "The join graph" below.

**Visualization** offers the whole gallery — every catalog type except the
slicer — with types the current selection cannot draw shown disabled rather
than hidden. **Data** carries the results table, the SQL that ran, and a **row
limit** (default 500, up to the server's cap of 10,000).

**Add to report** hands the report the visual currently on screen, not always
a bar: a lone dimension becomes a table, a lone measure a card.

### The join graph

A `SEMANTIC_VIEW(...)` query is rooted at a base entity Snowflake picks for
itself, and everything else named in the query must be reachable from it along
declared relationships. Break that and the query fails at compile time with
one of three "Invalid dimension specified" errors.

Two things follow, and both are visible in the explorer:

1. **Dimension-only queries across unrelated entities are repaired**, not
   refused. A connecting entity is added as a metric and projected away, so
   the answer is the combinations that actually occur. The response says which
   entity it went through — that narrowing is real and is not left implicit.
2. **What cannot be repaired is not offered.** A coarse measure poisons the
   query whatever else is selected, so those fields are dimmed with the reason.

The rules were established by running roughly eighty combinations against a
real account, not read from documentation:
`docs/superpowers/specs/2026-08-16-join-graph-findings.md`.
`backend/tests/integration/test_joins_it.py` re-runs the load-bearing ones, so
drift in Snowflake's behaviour fails a test rather than reaching a user.

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

**The sixteen visual types and what each well takes** (the single source is
`backend/app/reports/catalog.py`, mirrored in `frontend/src/reports/catalog.ts`):

| Type | Wells |
| --- | --- |
| Column, Bar, Line, Area | Axis (1 dimension), Legend (0-1 dimension), Values (1+ metrics) |
| Line and column | Axis (1 dimension), Column values (1+ metrics), Line values (0+ metrics) |
| Pie, Donut, Treemap, Funnel | Legend (1 dimension), Values (1 metric) |
| Gauge | Value (1 metric), Target (0-1 metric) |
| Scatter | X axis (1 metric), Y axis (1 metric), Detail (0-1 dimension) |
| Table | Dimensions (0+), Metrics (0+) - at least one field total |
| Matrix | Rows (1+ dimensions), Columns (0-1 dimension), Values (1+ metrics) |
| Card | Value (1 metric) |
| Multi-row card | Fields (0+ dimensions), Values (1+ metrics) |
| Slicer | Field (1 dimension) |

A field may only occupy one well on a visual at a time.

**Format.** The Visualizations pane's Format tab covers the title, legend
(position, title, text size), values (number format, data labels and their
size), axes (gridlines, X/Y titles, text size), the type's own options
(stacking, donut hole, subtotals) and sort/top-N. **Colours** take hex: per
series, per tile background, and — with no visual selected — the canvas
itself. Only well-formed hex is accepted, because these values reach a `style`
attribute and an ECharts option.

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

Filters live in the definition document at **three** scopes, in the order the
pane shows them: **this visual**, **this page**, and **all pages**. They
compose by intersection - a visual's effective filter set is all-pages AND
page AND its own AND its drill path AND any active cross-filter. Each scope's
heading carries an ⓘ that explains it on request rather than permanently.

Every operator maps to one bound-parameter predicate:

| `op` | Fields | Predicate |
|---|---|---|
| `is` | `values: string[]` | `field IN (?, ?)`; a single value emits `=` |
| `isNot` | `values: string[]` | `field NOT IN (?, ?)`; a single value emits `<>` |
| `contains` / `notContains` | `value` | `CONTAINS(UPPER(field), ?)`, negated for the second |
| `startsWith` / `endsWith` | `value` | `STARTSWITH` / `ENDSWITH`, same shape |
| `gt` / `gte` / `lt` / `lte` | `value` | `field > ?` and so on |
| `isBlank` / `isNotBlank` | none | `(field IS NULL OR field = '')`, negated for the second; **binds nothing** |
| `between` / `notBetween` | `from`, `to` | `field BETWEEN ? AND ?` |
| `relativeDate` | `unit`+`count`, or `preset` | resolved server-side to `field BETWEEN ? AND ?` |

**Text matching ignores case.** `CONTAINS(segment, 'mach')` finds nothing in a
column of `MACHINERY`, so both sides are upper-cased - the column in SQL, the
value in Python. `LIKE ... ESCAPE` is a syntax error inside `SEMANTIC_VIEW()`,
which is why these are the literal substring functions and not patterns: they
have no wildcard semantics, so there is nothing to escape.

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

### Schema version 3

Filters and hierarchies moved `SCHEMA_VERSION` to 2; **pages** moved it to 3.
`migrate_definition` runs *before* validation and chains v1 → v2 → v3, so a
v1 document gains the empty collections and a v2 document's top-level visuals
become its first page. It runs on the read path as well as on save, so a
report written before either change keeps opening forever. Anything above the
current version is still rejected.

### Distinct values for the filter editor

`GET /api/semantic-views/{db}/{schema}/{name}/values?field=TABLE.FIELD` runs a
capped query on the caller's own connection through the same builder every
other query uses, so a user is only ever offered values their Snowflake role
can already read. It takes `search` and `limit` as well, and returns **ten**
values by default with `truncated` meaning "more match" - a prompt to keep
typing rather than an apology for an unusable list.

**The search runs on the server**, inside the `SEMANTIC_VIEW(...)` call, as an
ordinary bound `contains` filter. That is the whole point: a column of 150,000
customer names cannot be searched by fetching a page and filtering it, because
the name wanted is almost never in the page. One `ValuePicker` serves the
filter editor and the slicer, so "search" means one thing wherever you are.

NULL is dropped, because `IN (?)` never matches it and offering it would build
a filter that silently returns nothing.


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


## Chat: asking a report a question

The **💬 Chat** button opens a floating, resizable panel over the canvas —
not a modal, because you consult it while reading the report. Each answer can
be added to the report as a visual, which is what "build a report by chatting"
amounts to once the model already proposes a query spec.

`POST /api/reports/{id}/ask` takes a plain-language question, optional
conversation `history`, and answers with numbers from the report's own
semantic view.

**It is a conversation.** Each question is sent with the ones before it, so
"now split that by region" is answerable. Only *answered* turns become
history: an unanswered question would tell the model something was asked and
leave it guessing what came of it. What travels back is the question and the
model's own one-sentence explanation — **never the rows**. Keeping data out of
the prompt is what makes this safe to point at a governed model, and a chat is
where it would be easiest to lose by accident, so there is a test on each side
asserting exactly that. History is trimmed to the last six turns.

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

### The live connection

There is one **Excel** button. It downloads the workbook described above —
and that workbook carries a **connection per sheet**, so Data → Refresh All
re-runs each query against Snowflake. The caret beside it opens the
fallbacks: a `.odc` file per query, the copyable SQL, and the manual
Get Data → From Snowflake steps.

**No credential is written into the file.** Excel prompts for a sign-in, so
the workbook refreshes as whoever opened it — the same rule the rest of the
product runs on, and one a file carrying a password would break the first time
a workbook was forwarded.

**Refreshing needs the Snowflake ODBC driver** on the machine that opens the
file. The embedded connection reaches ODBC through MSDASQL. Power Query's own
Snowflake connector needs no driver but stores its definition in an
undocumented binary part of the `.xlsx`, which is not something to
hand-author — which is why the manual route is still there.

The account identifier is read from `CURRENT_ORGANIZATION_NAME()` and
`CURRENT_ACCOUNT_NAME()` on your connection, not from `CURRENT_ACCOUNT()`.
The latter returns the account *locator*, which only resolves as a hostname in
Snowflake's default region — handing it to Excel gives a server string that
simply fails outside that region.

**What a refreshable workbook is not.** It is a flat result set that re-runs
one statement. It is not an SSAS cube: expanding a member cannot fetch a grain
that was never exported, because Excel would need MDX over XMLA and Snowflake
speaks SQL. Pivoting a loaded extract works within the columns you exported;
drilling below them means going back to the app, which re-queries Snowflake on
every drill. See `docs/superpowers/manual-passes/2026-08-17-live-excel-and-colours.md`
for what has and has not been verified here — including that the embedded
connection is assembled by editing OOXML parts by hand, and was found corrupt
once already.

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
>
> **Sections re-checked against the source on 2026-08-17**, when the setup
> instructions were written: setup, the explorer, the visual catalog and
> Format pane, filters and the values endpoint, schema version, chat, and the
> Excel live connection. All of those had drifted from the code.
>
> **Not re-checked in that pass**: the manual smoke-test checklist below,
> whose steps 1-14 still describe the pre-Looker explorer (three panes,
> Axis/Legend wells capped at one field). They are a record of what was walked
> through at the time, not instructions that currently match the UI.
