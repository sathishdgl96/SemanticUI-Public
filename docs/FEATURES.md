# Enterprise capabilities

What this deployment offers an organisation, and the guarantee behind
each one. The README explains how to run it and how each screen behaves;
this is the shorter list a platform team asks for.

Security has its own document: [SECURITY.md](SECURITY.md).

---

## The property everything else rests on

**Every query runs on the caller's own Snowflake connection.** There is
no service account, no shared credential, and no cached result set that
one person's role can read out of another person's session. Sharing a
report shares the *definition* — which fields, which filters, which
layout — and never the numbers.

The consequence worth stating plainly: **this app cannot widen anybody's
access to data.** If Snowflake refuses a user a table, they see the
refusal here too, in Snowflake's own words. Adding someone to a workspace
grants them a document, not a grant.

---

## Identity and access

| Capability | What it means |
|---|---|
| **Single sign-on** | Snowflake External OAuth (Entra ID, Okta, any OIDC IdP) or Snowflake's built-in OAuth. PKCE on the authorization code, exchanged by the backend as a confidential client, so the browser never holds a Snowflake token. The default install offers **nothing else** — direct credentials must be named explicitly, and production may only ever name key-pair. Setup: [operations/snowflake-sso.md](operations/snowflake-sso.md). |
| **Role and warehouse** | Chosen at sign-in from what the user's Snowflake account actually grants, remembered per user, and switchable from the profile menu without signing out. |
| **Multi-account** | The login page can offer a list of Snowflake accounts; the chosen one is bound to the session so a rebuilt connection cannot silently land elsewhere. |
| **Workspaces** | Reports, dashboards and explores live in a workspace. Membership decides who may read and who may write — never who created a thing. |
| **Three roles** | Viewer reads. Editor creates and changes. Admin also manages members. The last admin cannot be removed or demoted. |
| **App administrators** | A separate list, read from the environment, that opens the admin area. Deliberately not a database row: a permission to read everyone's activity is not one anybody inside the app should be able to grant themselves. |

---

## Governance and auditability

**An audit trail that is value-free by contract.** Every security-relevant
act is recorded — sign-in, sign-out, refusals, every create/read/update/
delete of a report, dashboard or explore, every membership change, every
query run, every token minted, every export. What is recorded is *shapes*:
counts, flags, durations, ids. Never a data value, a resource name, a
filter or a token. The activity log can therefore be shown to an operator
in full without leaking the contents of anybody's report.

Each event carries the request id, so an audit row joins the application
log stream — and through the Snowflake query id logged there, Snowflake's
own `QUERY_HISTORY`.

A test enumerates every action the app is expected to write and fails if
an endpoint is added without one, because four subsystems once went
unaudited before anybody noticed the log looked thin.

**The admin area** (app administrators only):

- **Operations** — is each part answering, and how quickly. The database
  check is a real round trip, not a connection-pool reading: a pool can
  hold a handle to a server that has stopped answering.
- **Activity log** — the trail, filtered by window, action, outcome and
  user; any row opens into its full record. Paged by timestamp rather
  than offset, because the trail grows while it is being read.
- **Security** — alerts derived from the same trail: failed sign-ins,
  throttling engaged, refusals grouped by who collected them. Alerts
  rather than raw counts, each saying what it counted over what window.
- **Announcements** — a notice shown to every signed-in user, wherever
  they are in the app, with a level and an optional end.

---

## Modelling and analysis

- **Snowflake semantic views** as the only source of truth. Dimensions,
  metrics and facts come from the model; the app never invents a measure.
- **Join-graph awareness.** The server knows which field combinations are
  answerable and says so *before* the query runs, rather than surfacing
  Snowflake's "Invalid dimension specified" after a round trip. Where a
  pair needs a third entity to be joinable, it bridges and says which.
- **Model diagram** — the semantic view as an interactive ER diagram:
  tables, relationships in crow's-foot notation, and the columns each
  join is declared on. Click a column to see everything it reaches, how
  many joins away, in which direction, and whether the two can be asked
  for together.
- **Explorer** — pick fields, filter, sort, see the SQL. Save as an
  explore into any workspace you can write to.
- **Reports** — a canvas of visuals over one semantic view, with pages,
  three filter scopes (report, page, visual), hierarchies and drill-down,
  and cross-filtering.
- **Dashboards** — a workspace object that gathers visuals from *several*
  reports onto one canvas. Each tile names a visual rather than copying
  one, so it follows edits to its report and carries that report's own
  filters with it.
- **Chat** — ask a report a question in English. The model proposes a
  query; it never executes one and never sees data. The SQL is always
  shown, because an answer you cannot audit is one you should not act on.

---

## Getting data out

- **Excel workbook** — the numbers *and* a live connection that refreshes
  them, in one file. Formula injection is neutralised on the way out.
- **Live connection** — Excel's Analysis Services connector speaks to the
  app's XMLA endpoint over a scoped, revocable connect token that rides on
  one session, with its own lifetime.
- **Portable definitions** — every report, dashboard and explore exports
  as a document and imports again, byte-stable across two exports of the
  same thing.

---

## Operating at size

Written and measured against a **500-user** target. What matters at that
size is not how fast one statement is but whether the number of
statements grows with the data, so the suite counts queries rather than
milliseconds.

- Every listing costs a **constant** number of queries — the same at sixty
  rows as at five. Membership and workspace names are read once per page,
  not once per row.
- Pins, recents, filtering and ordering happen **in the database**, not
  after loading a workspace into memory.
- Listings are **bounded** at 200 rows and say so when a list was cut
  short — a list that is silently a fraction of the truth is worse than a
  slow one.
- The security board **counts in SQL** and fetches only the rows it
  shows.
- Indexes exist for the queries the app actually runs, each named for one.

---

## Deployment

- **Containers** with health and readiness probes (`/healthz`, `/readyz`).
- **PostgreSQL** for application state; SQLite for local development.
- **Alembic migrations**, forward and reversible.
- **Branding** — product name, logo, sign-in backdrop and tagline, from
  configuration. A logo or backdrop can be a URL or a file the app serves.
- **Configuration is environment-only.** No secret is ever read from the
  database or written to it in the clear.
