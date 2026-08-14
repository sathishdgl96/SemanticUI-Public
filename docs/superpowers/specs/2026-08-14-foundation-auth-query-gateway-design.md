# Foundation: Per-User Auth, Query Gateway & Semantic View Explorer — Design

**Date:** 2026-08-14
**Status:** Approved pending final review
**Sub-project:** 1 of 5 (see Roadmap Context)

## Roadmap Context

This is the first sub-project of a PowerBI-like reporting platform on top of
Snowflake semantic views. The agreed decomposition:

1. **Foundation: auth + query gateway + semantic view explorer** ← this spec
2. Report authoring & saved reports (chart catalog, hierarchies, drill-down,
   filters, multi-visual pages, save/load to Postgres)
3. Workspaces & sharing (roles; shared reports always execute with the
   *viewer's* Snowflake credentials)
4. LLM Q&A via Snowflake Cortex Analyst (runs under the user's session)
5. Excel export (formatted .xlsx)

Platform-wide decisions already made:

- **Deployment model:** standalone web app (React frontend + FastAPI backend),
  self-hosted.
- **LLM:** Snowflake Cortex Analyst (data never leaves Snowflake; user's own
  permissions apply). Not part of this sub-project.
- **Snowflake auth:** Snowflake built-in OAuth for real deployments; a local
  dev mode that requires **no security integration** (externalbrowser or
  password authenticator).
- **App metadata store:** PostgreSQL. Report *data* is never stored by the
  app — it always flows live from Snowflake under the requesting user's own
  session.
- **Connection management:** per-user connection cache (Approach B), behind a
  `ConnectionProvider` interface so a dedicated connection-broker service
  remains a future option.

## Goal of This Sub-Project

A signed-in user can:

1. Authenticate to the app with their **own** Snowflake identity
   (OAuth in production; externalbrowser/password in local dev).
2. Browse semantic views they are entitled to see
   (database → schema → semantic view → dimensions & metrics).
3. Select dimensions/metrics, run an ad-hoc query, and see the result as a
   table plus a basic auto-chart, with a read-only preview of the SQL sent.

Every Snowflake statement executes on a connection authenticated as that
user; Snowflake RBAC is the sole authority on data access.

## Architecture

```
Browser (React SPA)
   │  session cookie (HttpOnly) — tokens NEVER reach the browser
   ▼
FastAPI backend ──── PostgreSQL (sessions w/ encrypted tokens)
   │
   ▼
ConnectionProvider → per-user connection cache → Snowflake (user's own session)
```

- **Frontend:** React + TypeScript (Vite), TanStack Query for server state,
  ECharts for the preview chart.
- **Backend:** Python 3.12, FastAPI, SQLAlchemy + Alembic on Postgres,
  `snowflake-connector-python`. The connector is synchronous; all Snowflake
  calls run in a threadpool behind async endpoints.
- **Postgres:** app bookkeeping only (this sub-project: sessions).

### Repository Layout

```
SemanticUI/
  backend/
    app/
      main.py, config.py        # pydantic-settings; AUTH_MODE=oauth|dev
      auth/                     # OAuth flow, dev login, sessions, crypto
      snowflake/                # ConnectionProvider, cache, query gateway
      semantic/                 # semantic view discovery + query endpoints
      db/                       # SQLAlchemy models + Alembic migrations
    tests/
  frontend/
    src/
      api/  auth/  explorer/  query/
  docs/superpowers/specs/
```

### Unit Boundaries

- Everything downstream of auth depends only on the `ConnectionProvider`
  interface: *"give me a live Snowflake connection for this session."*
  OAuth vs dev mode — and any future broker service — are invisible to the
  rest of the app.
- `semantic/` knows how to discover/describe/query semantic views but knows
  nothing about auth. `auth/` knows nothing about semantic views.

## Auth Subsystem

### OAuth Mode (production; `AUTH_MODE=oauth`)

Authorization-code flow against Snowflake built-in OAuth (confidential
client: client id + secret configured on the backend; a Snowflake
`SECURITY INTEGRATION` of type OAUTH must exist with
`OAUTH_ISSUE_REFRESH_TOKENS = TRUE`).

1. `GET /auth/login` → 302 to the account's `/oauth/authorize` with
   `client_id`, `redirect_uri`, and a random `state` (stored server-side,
   single-use, short TTL).
2. User signs in on Snowflake's own login page (honors the account's
   SSO/MFA) and consents.
3. `GET /auth/callback` → validate `state`; exchange the code at
   `/oauth/token-request` for **access + refresh tokens**; open one
   connection to read `CURRENT_USER()` / `CURRENT_ACCOUNT()`; create a
   session row (see Data Model); set the session cookie.
4. Cookie: session id only — `HttpOnly; Secure; SameSite=Lax`
   (`Secure` relaxed only under `AUTH_MODE=dev` on localhost).
5. **Silent refresh:** Snowflake access tokens live ~10 minutes. On every
   connection build/rebuild the provider checks expiry and redeems the
   refresh token transparently, updating the session row. When the refresh
   token itself expires, APIs return `401 AUTH_EXPIRED` and the frontend
   routes to login.
6. `POST /auth/logout`: delete session row, evict cached connection,
   best-effort token revocation.

OAuth sessions **survive backend restarts**: tokens live encrypted in
Postgres and connections rebuild silently on next use.

### Dev Mode (local only; `AUTH_MODE=dev`)

- The backend **refuses to start** with `AUTH_MODE=dev` when
  `ENVIRONMENT=production`.
- `POST /auth/dev-login` body: `{account, user, authenticator, password?}`
  where `authenticator ∈ {externalbrowser, password}`.
  - `externalbrowser`: `snowflake.connector.connect(...)` pops the local
    default browser once for SSO/login (satisfies the "external browser
    support" requirement). Works with zero security-integration setup.
  - `password`: used for the single connect call, never stored.
- On success: create a session row flagged `mode=dev` (no stored tokens) and
  place the live connection directly into the cache.
- If the dev connection dies (idle eviction, backend restart), the API
  returns `401 AUTH_EXPIRED` and the user logs in again — acceptable in dev.
- `GET /api/config` tells the frontend which mode is active so it renders
  the OAuth button or the dev-login form.

### Security (cross-cutting)

- Tokens encrypted at rest with Fernet; key from env/KMS, never in code or
  repo. Tokens never logged, never serialized to the browser.
- OAuth `state` validated; sessions expire after inactivity (default 8h,
  configurable); session ids are 256-bit random.
- No SQL text is accepted from the browser in v1 (see Query Gateway).

## Data Model (Postgres)

`sessions` table:

| column            | type        | notes                                   |
|-------------------|-------------|-----------------------------------------|
| id                | text PK     | 256-bit random, url-safe                |
| mode              | text        | `oauth` \| `dev`                        |
| snowflake_user    | text        | from `CURRENT_USER()`                   |
| snowflake_account | text        | from `CURRENT_ACCOUNT()`                |
| access_token_enc  | bytea null  | Fernet-encrypted (oauth only)           |
| refresh_token_enc | bytea null  | Fernet-encrypted (oauth only)           |
| access_expires_at | timestamptz | oauth only                              |
| created_at        | timestamptz |                                         |
| last_seen_at      | timestamptz | drives inactivity expiry                |

Alembic owns the schema from day one.

## Connection Cache & Query Gateway

### ConnectionProvider / cache

- In-process map `session_id → {connection, last_used, asyncio.Lock}`.
- Idle TTL eviction (default 15 min) via background task; hard cap with LRU
  eviction; liveness check before reuse (`is_closed()` + cheap ping when
  stale).
- One in-flight query per session (the lock); OAuth connections rebuild
  transparently on token expiry; dev connections cannot rebuild → 401.
- Scale-out note: stateful backend ⇒ sticky sessions if ever run with >1
  replica. Accepted for v1; broker service is the future escape hatch.

### Query gateway

The **only** path to Snowflake. Enforces:

- statement timeout (default 60s, configurable)
- row cap for the UI (default 10,000) surfaced as `truncated: true`
- response shape `{columns: [{name, type}], rows, truncated, sfqid}`

The backend *generates* all SQL from structured requests. Identifiers are
validated against the described semantic view before being placed in SQL —
no interpolation of raw user text.

## API

| Endpoint | Behavior |
|---|---|
| `GET /auth/login` | OAuth redirect (oauth mode) |
| `GET /auth/callback` | Code exchange, session creation |
| `POST /auth/dev-login` | Dev-mode login (dev mode only) |
| `POST /auth/logout` | Destroy session + connection |
| `GET /api/config` | `{authMode}` for the frontend |
| `GET /api/me` | `{snowflakeUser, account, mode}` |
| `GET /api/semantic-views?database=&schema=` | `SHOW SEMANTIC VIEWS` — `IN SCHEMA` when both params given, `IN DATABASE` with only `database`, `IN ACCOUNT` with neither |
| `GET /api/semantic-views/{db}/{schema}/{name}` | `DESCRIBE SEMANTIC VIEW`, parsed into logical tables, relationships, dimensions, metrics |
| `POST /api/query/semantic` | `{view, dimensions[], metrics[], orderBy?, limit?}` → `SELECT * FROM SEMANTIC_VIEW(<view> DIMENSIONS … METRICS …)` |

Every data call runs on the caller's own connection; Snowflake RBAC decides
visibility. The app never filters entitlements on Snowflake's behalf.

## Explorer UI

- **Login page:** OAuth button, or dev-login form (account, user,
  authenticator picker, optional password) per `/api/config`.
- **Left rail:** database → schema → semantic view tree; selecting a view
  lists its dimensions and metrics as checkable fields.
- **Main panel:** Run button → results table + basic auto-chart + read-only
  "SQL sent" preview. Auto-chart rule: exactly 1 dimension + ≥1 metric →
  bar chart (line if the dimension type is date/time); any other shape
  (0 or 2+ dimensions) → table only. Full chart catalog is sub-project 2.
- 401 responses anywhere route to the login page.

## Error Handling

Single typed envelope `{code, message, detail?}`:

| code | HTTP | meaning |
|---|---|---|
| `AUTH_EXPIRED` | 401 | session/token gone → login |
| `SNOWFLAKE_FORBIDDEN` | 403 | Snowflake privilege error, passed through honestly |
| `QUERY_ERROR` | 400 | Snowflake's own error message surfaced |
| `TIMEOUT` | 504 | statement timeout hit |

`truncated` is a response flag, not an error. No stack traces or tokens in
any response body.

## Testing

TDD throughout (superpowers:test-driven-development).

- **Unit (backend):** token crypto round-trip; session lifecycle; cache
  eviction/refresh/lock behavior against a fake connector; SQL generation
  incl. identifier-injection attempts; `DESCRIBE SEMANTIC VIEW` parsing
  against captured real output.
- **Integration:** marked pytest suite against the real Snowflake account
  via env credentials; auto-skipped when creds are absent (e.g., CI).
- **Frontend:** Vitest + Testing Library with a mocked API client.

## Out of Scope (later sub-projects)

Chart catalog & drill-down hierarchies (2); saving reports (2); workspaces,
roles, sharing (3); Cortex Analyst Q&A (4); Excel export (5); horizontal
scaling of the connection cache; accepting raw SQL from the browser.
