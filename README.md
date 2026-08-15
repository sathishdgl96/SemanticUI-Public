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
report** button (top bar, enabled once a view is selected and at least one
field is placed in a well) does the same but seeds it with a single Bar
visual holding the wells you already built - a one-click hand-off from ad
hoc exploration to a saved report.

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

then run `pytest -m integration -v`. With `SEMANTICUI_IT_ACCOUNT` unset, all
five tests (four Snowflake-gateway tests plus the report round trip in
`test_reports_it.py`) are cleanly **skipped** (not errored, not failed) via
each module's own `skipif`.

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
up:

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

> **Note on this checklist:** items 1-14 (auth/explorer) are written to be
> followed by a human against a real Snowflake account and have not been
> re-executed against a live account as part of this change (no Snowflake
> account was available in this environment). Item 15 (report round trip)
> *was* driven end-to-end in a real Chromium browser against the running
> app, with only the network layer stubbed (Playwright `page.route()` faking
> `/api/*` responses) since no Snowflake account was available - every
> component, layout rule, and interaction (click-to-place, drag, resize,
> type switching, per-tile error isolation, save/export/import) was
> exercised for real. That pass caught and led to a fix for a real bug: at
> the <960px stacked breakpoint, a chart tile's height resolved to 0 (a
> `height: 100%` percentage chain through an ancestor whose own `height` was
> `auto`), leaving every chart blank on narrow screens even though the query
> underneath had succeeded; `.tile-body`/`.auto-chart` now use flex sizing
> instead. Everything else in this README - config keys, validator behavior,
> endpoint names, component/interaction behavior - was verified directly
> against the source in `backend/app` and `frontend/src`.
