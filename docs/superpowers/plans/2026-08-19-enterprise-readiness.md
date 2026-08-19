# Enterprise Readiness Plan: SSO, Security, Observability, Containers, Maintainability

> Program-level roadmap. Each task names the files it touches and the
> acceptance criterion that closes it. Ordered so every phase leaves the
> app deployable; nothing depends on a later phase to be safe.

## 0. Direction decisions (set by the product owner)

1. **SSO through a Snowflake security integration is THE auth path.**
   Users sign in via OAuth against Snowflake (which fronts the corporate
   IdP); the app never sees or stores a Snowflake password. The current
   dev-login (password/key-pair) becomes a development-only mode, refused
   in production. The codebase is already shaped for this: `auth_mode=
   oauth`, `connect_oauth`, the refresh flow and Fernet-encrypted token
   storage exist — what remains is making it primary, documented, and
   operationally complete.
2. **Containerized deployment for scalability.** One backend image, the
   SPA built and served behind it (or a proxy), horizontal replicas.
   OAuth makes this tractable: an OAuth session's Snowflake connection is
   **rebuildable from its stored refresh token on any replica**, so
   scaling out does not strand users the way dev-mode connections would.
3. **Maintainability means a future developer ramps fast.** Modularity
   with explicit boundaries AND a documentation program (onboarding,
   per-package intent, ADRs, runbooks) are first-class deliverables, not
   afterthoughts.

## 1. Where we stand (honest inventory)

Strengths already in place:

| Area | What exists today |
| --- | --- |
| Data-plane auth | Every query runs on the caller's own Snowflake connection; no shared service account exists to leak |
| OAuth plumbing | `auth/oauth.py` + `connect_oauth` + refresh-with-skew + Fernet-encrypted access/refresh tokens in `sessions`; the connection cache already rebuilds OAuth connections transparently |
| Authorization | Workspace RBAC via `require_access` (404 non-member, 403 low role) |
| Injection | All values are bound parameters (tuple-IN combos included); identifiers quoted; test-enforced |
| Secrets | Production refuses the default `SECRET_KEY`; connect tokens stored as sha256 only, one-shot display, ≤24 h, die with the session |
| Session | HttpOnly, SameSite=lax, Secure outside dev; DB-backed TTL + purge sweeper |
| Export hygiene | No credentials/identity in any artifact; CSV formula-injection guards |
| Traceability seed | `QueryResult.sfqid` captures Snowflake's query id on every statement |

Gaps this plan closes:

| Gap | Evidence |
| --- | --- |
| SSO not primary | Dev-login is the exercised path; the OAuth flow has no Snowflake-side setup doc, no group→workspace mapping, and little test traffic |
| Not containerized | No Dockerfile/compose; `dev.py` is the only runner; scale-out semantics (per-process caches) undocumented |
| No audit trail | Nothing records who read which report, exported what, or minted a token |
| No request correlation | No request-ID middleware; logs can't be tied to a user action |
| Sparse, unstructured logging | ~6 of ~40 backend modules log; plain text; ad-hoc handlers |
| No security headers / throttling / CSRF decision | No middleware; unlimited auth attempts; SameSite-only CSRF posture |
| No CI, lockfile, scanning | `.github/workflows` absent; floor pins; no CVE/secret scanning |
| Oversized modules | `BuilderPage.tsx` ~1,300 lines; `xmla/execute.py`'s `_Engine.execute` does axis building AND cells |
| Documentation partial | `docs/architecture/*` exists and is good; no onboarding guide, no ADRs, no per-package intent docs, no ops runbooks |

## 2. Guiding principles

1. **Anchor to the funnels.** Instrumentation goes into
   `build_semantic_sql`/`gateway.run_query` and the auth resolvers —
   never per-endpoint sprinkles.
2. **Logs for operators, audits for compliance** — two streams, one
   request id joining them. **Never log data**: no row values, filter
   values, member names or tokens in any log line.
3. **Every phase ships green.** 718 backend + 470 frontend tests are the
   floor; each task adds its own.
4. **Documentation ships with the code it describes** — same PR, or it
   does not merge.

## 3. Workstream S — SSO via Snowflake security integration  (P0)

- **S1 Snowflake-side setup, documented and scripted.** A runbook +
  idempotent SQL: `CREATE SECURITY INTEGRATION` (type OAUTH /
  external-OAuth variant when the IdP fronts Snowflake), redirect URIs,
  refresh-token lifetime, blocked-roles review. Lives in
  `docs/operations/snowflake-sso.md` with the exact grants the app needs.
  *Accept:* a fresh Snowflake account can be wired up from the doc alone.
- **S2 OAuth mode to first-class.** Exercise and harden
  `auth/oauth.py`: state parameter entropy + expiry (verify), PKCE if the
  integration supports it, error paths (denied consent, expired refresh)
  land on friendly UI states. Integration tests behind the existing
  env-gated marker; unit tests with a fake token endpoint. *Accept:*
  full login→query→refresh→logout covered.
- **S3 Dev-login demoted.** `config.py`: production refuses
  `auth_mode=dev` (hard, no override flag); LoginPage hides the dev form
  unless the branding endpoint says dev mode. *Accept:* config + UI
  tests.
- **S4 Excel on SSO sessions.** Connect tokens already ride the app
  session — verify the full Excel matrix (XMLA, Power Query feed) on an
  OAuth session, including refresh-during-long-pivot and
  rebuild-after-restart (OAuth's rebuildable connections should REMOVE
  today's "restart strands Excel" caveat — prove it and update docs).
  *Accept:* live COM-driven Excel pass on an OAuth session.
- **S5 Workspace membership from the IdP (P1).** Map IdP/Snowflake roles
  or groups to workspace membership on login (configurable mapping
  table); manual membership remains for exceptions. *Accept:* login
  provisions membership per mapping; removal on next login when the
  group is gone.

## 4. Workstream A — Security hardening

### Phase A1 (P0)

- **A1.1 Security-header middleware** (`app/main.py`): nosniff,
  Referrer-Policy, X-Frame-Options DENY, no-store on `/api`+`/auth`,
  HSTS in production; CSP for the SPA (`default-src 'self'` plus what the
  Vite build needs). *Accept:* header assertions in tests; SPA runs
  under the CSP.
- **A1.2 Auth throttling.** Sliding-window limiter on `/auth/*`, connect
  token resolution, and XMLA/feed 401 paths; 429s carry no
  user-existence signal. *Accept:* allow→throttle→recover tests; audit
  events on lockout.
- **A1.3 CSRF decision, implemented.** JSON-only + SameSite=lax + a
  required custom header on state-changing routes; `/xmla` and
  `/api/feed` exempt (token auth, no cookies). *Accept:* forged-form
  test fails, SPA flows pass.
- **A1.4 Production guardrails** (`config.py`): refuse dev auth (S3),
  refuse `SEMANTICUI_XMLA_TRACE`, refuse localhost DB default.
- **A1.5 Credential hygiene.** Rotate the Snowflake dev password (owner
  action, still open); `gitleaks` + `detect-secrets` baseline in CI.

### Phase A2 (P1)

- **A2.1 Token security posture.** The two token types have opposite
  designs, and the hardening differs accordingly:

  *Connect tokens are never stored* -- only their sha256 lands in the DB,
  the raw value is shown once. A stolen database yields nothing usable.
  Remaining work: logout-kills-token proven by test, optional IP
  pinning, and the client-side exposure documented honestly (Excel's
  credential store holds the raw token for its TTL; TLS is mandatory).

  *SSO refresh tokens must be stored* -- a confidential OAuth client
  that rebuilds connections across replicas and serves Excel refreshes
  cannot function without them; "store nothing" means re-login on every
  access-token expiry and no scale-out. Harden HOW they are held:
  1. **Persist only the refresh token.** The access token is
     short-lived; keep it in the in-process connection cache and drop
     `access_token_enc` from the sessions table (schema + code change,
     small). Shrinks the at-rest surface to the one credential that
     genuinely needs persistence.
  2. **Envelope encryption with an external key.** Replace
     derive-from-SECRET_KEY with a data-key wrapped by a KMS/Vault
     transit key (pluggable `crypto.py` backend; Fernet stays as the
     dev-mode fallback). An attacker with the DB alone gets ciphertext;
     with the app server alone gets no historical dumps. Key rotation
     becomes a re-wrap, not a re-login of every user.
  3. **Tighten the Snowflake side**: `OAUTH_REFRESH_TOKEN_VALIDITY`
     set deliberately (e.g. 7-30 days, not the 90-day default), blocked
     high-privilege roles left blocked, and the per-user revocation
     path (`ALTER USER ... REMOVE DELEGATED AUTHORIZATIONS`) written
     into the ops runbook -- Snowflake-side revocation is the kill
     switch that works even if the app is compromised.
  4. **Audit token lifecycle** (with C1): mint, first-use,
     use-from-new-address, refresh-failure -- so a stolen token's use is
     visible, not silent.
- **A2.2 Input ceilings**: request size limits, filter count/length caps
  swept in `reports/schema.py`, XMLA statement length cap in `soap.py`;
  XML parsing posture reviewed (entity expansion off — the XMLA parser
  reads attacker-suppliable XML).
- **A2.3 Threat model** (`docs/architecture/threat-model.md`): STRIDE
  over the four client paths; the XMLA adapter and the OAuth redirect
  flow get their own sections; owner + quarterly review date.

## 5. Workstream B — Logging  (P0 core)

- **B1 Central JSON logging** (`app/logging.py`): JSON lines to stdout
  (container-native), fields `ts, level, logger, msg, request_id,
  user_id, path, status, duration_ms`; uvicorn routed through it; the
  ad-hoc handler in `xmla/routes.py` removed; no `print()` in `app/`.
- **B2 Request-ID middleware**: honours proxy `X-Request-ID`, contextvar
  propagation, one summary line per request; the id is also written into
  XMLA wire-trace markers so traces join logs.
- **B3 Query logging (P1)** in `gateway.run_query`: field refs, row
  count, duration, `sfqid`, truncated — parameters never. `sfqid` is the
  bridge to Snowflake `QUERY_HISTORY` forensics.
- **B4 Log hygiene test (P1)**: captured logs from representative flows
  are grepped for `xlt_` prefixes, passwords and bound values — the
  "never log data" rule as a regression test.

## 6. Workstream C — Traceability & audit

- **C1 (P0) `audit_events` table** (alembic 0006) + writer: `ts,
  request_id, user_id, session_id, action, resource_type, resource_id,
  outcome, detail(JSON, value-free)`. First tranche of actions:
  `auth.login/logout/login_failed`, `token.mint`, `report.
  create/update/delete/read`, `export.*`, `feed.read`,
  `xmla.session_open`, `workspace.member_*`. Denied access records
  `outcome=denied` without leaking resource names.
- **C2 (P1) Audit API + retention**: admin-scoped `GET /api/audit`
  (actor/action/time filters), CSV export through the formula guard,
  retention sweeper on `SEMANTICUI_AUDIT_RETENTION_DAYS`.
- **C3 (P1) Correlation runbook** (`docs/operations/observability.md`):
  audit row → request id → log line → `sfqid` → QUERY_HISTORY, one
  worked example.
- **C4 (P2) Definition history**: report saves retain prior definitions
  (history table or single-slot), so "who changed what" is diffable.

## 7. Workstream K — Containerization & scalability  (P0 core)

- **K1 Images.** Multi-stage `Dockerfile`: build SPA → build backend →
  slim runtime (non-root user, read-only FS where possible, healthcheck).
  The backend serves the built SPA (or a compose'd nginx does). *Accept:*
  `docker run` + env file yields a working app; image passes a trivy
  scan without high CVEs.
- **K2 Compose for dev/eval.** `docker-compose.yml`: app + Postgres,
  volumes for the DB only, `.env`-driven. `dev.py` stays for
  hot-reload development. *Accept:* `docker compose up` → login →
  query works from the docs alone.
- **K3 Health & readiness.** `/healthz` (process up) and `/readyz`
  (DB reachable); used by the container healthcheck and any orchestrator.
- **K4 Scale-out semantics, implemented and documented.** The two
  in-process states get explicit multi-replica behavior:
  - Connection cache: with SSO (S-workstream), any replica rebuilds a
    user's connection from the DB-stored refresh token — verify with two
    replicas behind a round-robin proxy in a test script.
  - XMLA `SessionStore`: MSOLAP re-presents the connect token digest, so
    a replica that never saw the BeginSession can re-open — verify, and
    fall back to documented sticky-session guidance only if a gap
    remains.
  *Accept:* a two-replica compose profile passes the API tests and a
  scripted Excel refresh.
- **K5 (P1) Orchestrator artifacts.** Helm chart or plain k8s manifests
  (Deployment, HPA notes, Secret/ConfigMap wiring, probes), plus a
  production topology diagram in `docs/operations/deployment.md`.

## 8. Workstream D — Maintainability, modularity, documentation

### D1 (P0) Delivery rails

- **D1.1 CI**: pytest + vitest + `tsc --noEmit` + ruff + eslint on every
  push/PR; red blocks merge.
- **D1.2 Scanning**: `pip-audit`, `npm audit` (fail high), `gitleaks`;
  weekly scheduled run; trivy on the image (K1).
- **D1.3 Lockfiles**: backend lock committed (uv/pip-tools); `npm ci`
  enforced.

### D2 (P1) Modularity for the next developer

Rule set, enforced in review and by lint where possible:

- **One module, one responsibility; ~400-line soft ceiling** for new
  code; existing violations get scheduled splits:
  - `frontend/src/reports/BuilderPage.tsx` → extract `usePageOps`
    (add/rename/duplicate/delete/sheet), `useDragRouting` (the dnd
    onDragEnd table), `useSelection`; BuilderPage becomes composition.
  - `backend/app/xmla/execute.py` → `_Engine` split into `AxisBuilder`
    (member walks, per-spec lists) and `CellResolver` (ordinal grid);
    same tests, no behavior change.
- **Boundaries stay explicit**: frontends of a package are its
  `routes.py`/exported functions; cross-package imports only through
  those (a lightweight import-linter contract file encodes the allowed
  edges: e.g. `xmla` may import `semantic`+`snowflake`+`auth`, never the
  reverse).
- **The two mirrored catalogs** (`reports/catalog.py` ↔
  `reports/catalog.ts`) keep their shared-expectation tests as the drift
  guard — documented as the pattern for any future mirror.

### D3 (P0→P1) Documentation program

- **D3.1 (P0) Onboarding guide** `docs/CONTRIBUTING.md`: clone → run →
  test → first PR in under an hour; where things live (pointer to
  `docs/architecture/*`); the wire-capture debugging workflow for XMLA
  (trace flag, ADOMD harness) written down as the way to work on that
  package.
- **D3.2 (P0) Per-package intent.** Every `app/*` package and every
  `frontend/src/*` area keeps its module docstring/header current — the
  codebase already does this well (e.g. `xmla/soap.py`, `feed/service.py`);
  make it a stated convention with a checklist item in PR review.
- **D3.3 (P1) ADR log** `docs/adr/`: backfill the decisions already
  made (own-connection model, connect tokens vs credentials in Excel,
  Mondrian-shape XMLA rowsets, client-side pivoting for the matrix,
  sheet-as-page), then one ADR per future structural decision.
- **D3.4 (P1) Ops runbooks** `docs/operations/`: deploy, upgrade
  (alembic), SSO setup (S1), observability/correlation (C3), incident
  quick-cards (auth outage, Snowflake outage, stuck sweeper).
- **D3.5 (P1) API reference**: FastAPI's OpenAPI already exists — pin
  titles/descriptions per route, publish the schema artifact in CI.
- **D3.6 Keep `docs/architecture/high-level.md` + `low-level.md` current**
  — updating them is part of any task that changes a boundary they draw.

## 9. Compliance mapping (pragmatic)

| Control family | Covered by |
| --- | --- |
| Authentication (ASVS V2) | S-workstream SSO + A1.2 throttling |
| Session management (V3) | Existing cookie posture + A2.1 |
| Access control (V4) | Existing RBAC + C1 audit of denials + S5 IdP mapping |
| Input validation (V5) | Bound params + A2.2 ceilings + B4 hygiene tests |
| Cryptography (V6) | Fernet at rest, hashed tokens; key rotation documented in threat model |
| Logging & monitoring (V7) | Workstreams B + C |
| Data protection (V8) | Never-log-data rule (B4), export guards, no result caching |
| Communications (V9) | TLS at the proxy + HSTS + deployment doc |
| Supply chain | D1.2/D1.3 + trivy + SBOM (P2, with releases) |

SOC 2 note: the audit trail with retention (C1/C2) and CI-enforced change
management (D1) are what auditors ask for first; both are P0/P1 by design.

## 10. Phasing and effort

| Phase | Contents | Effort (focused sessions) |
| --- | --- | --- |
| P0 | D1.*, B1, B2, S1–S4, A1.*, C1, K1–K4, D3.1–D3.2 | 5–7 |
| P1 | S5, A2.*, B3, B4, C2, C3, K5, D2.*, D3.3–D3.5 | 5–6 |
| P2 | C4, SBOM/releases, remaining polish | 2–3 |

Order within P0: **D1.1 (CI) first** — everything after lands enforced;
then **B1/B2** (audit wants the request id); then **S1–S4** (the auth
direction everything else assumes); **K1–K4** next (SSO makes scale-out
semantics provable); **A1.x** and **C1** close the phase.

## 11. Definition of "enterprise ready"

1. Sign-in is SSO through the Snowflake security integration; a
   production deployment cannot start in dev-auth mode, with a default
   secret, or with trace flags.
2. `docker compose up` (or the k8s manifests) yields a working, healthy,
   horizontally scalable deployment — proven by the two-replica test
   including an Excel refresh.
3. A denied access, a token mint and an Excel refresh are each traceable
   audit row → request id → log line → `sfqid` in under five minutes via
   the runbook.
4. CI blocks merges on tests, lint, types, high CVEs and leaked secrets;
   builds are reproducible from lockfiles; images scan clean.
5. Brute-forcing any auth surface yields 429s and audit events; no log
   line contains a token, password or data value — proven by a test.
6. A new developer follows CONTRIBUTING.md to a first merged PR inside a
   day; every package states its intent at the top of its files; ADRs
   explain why the big decisions look the way they do.
