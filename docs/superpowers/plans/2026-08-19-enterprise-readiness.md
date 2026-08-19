# Enterprise Readiness Plan: Security, Logging, Traceability, Maintainability

> Program-level roadmap. Each task names the files it touches and the
> acceptance criterion that closes it. Ordered so that every phase leaves
> the app deployable; nothing depends on a later phase to be safe.

## 1. Where we stand (honest inventory)

Strengths already in place — these are the foundation, not the gaps:

| Area | What exists today |
| --- | --- |
| Data-plane auth | Every query runs on the caller's own Snowflake connection; no shared service account exists to leak |
| Authorization | Workspace RBAC via `require_access` (404 non-member, 403 low role); `owner_user_id` is provenance only |
| Injection | All filter/member values are bound parameters (`app/semantic/predicates.py`, tuple-IN combos included); identifiers quoted via `quote_ident`; enforced by tests that assert values never appear in SQL text |
| Secrets | `SEMANTICUI_SECRET_KEY` refuses the published default and short keys in production (`config.py`); OAuth tokens Fernet-encrypted at rest; connect tokens stored as sha256 only, shown once, ≤24 h, die with the session |
| Session | HttpOnly, SameSite=lax, Secure outside dev; DB-backed with TTL + background purge |
| Export hygiene | No credentials or identity in any generated artifact; CSV formula-injection guard (`export/literals.py`, `feed/render.py`) |
| Traceability seed | `QueryResult.sfqid` already captures Snowflake's query id on every statement |

Gaps this plan closes:

| Gap | Evidence |
| --- | --- |
| No audit trail | Nothing records who read which report, exported what, or minted a token |
| No request correlation | No request-ID middleware; logs (where they exist) cannot be tied to a user action |
| Sparse, unstructured logging | 6 of ~40 backend modules log; plain-text format; no central config |
| No security headers / CSP | No middleware adds `X-Content-Type-Options`, `Referrer-Policy`, CSP, HSTS |
| No rate limiting or lockout | `POST /auth/dev-login` and the token/Basic paths accept unlimited attempts |
| No CI, no lockfile, no scanning | `.github/workflows` absent; `pyproject.toml` uses floor pins; no dependency or secret scanning |
| Dev credentials in `.env` | Real Snowflake credentials sit in a gitignored file on a developer machine; password was pasted in chat once (rotation still owed) |
| CSRF posture undocumented | SameSite=lax is the only defense; state-changing POSTs have no token; needs an explicit decision |
| XMLA wire trace risk | `SEMANTICUI_XMLA_TRACE` writes verbatim requests (Authorization redacted) — safe as designed but needs a production guard |

## 2. Guiding principles

1. **Anchor to the one query path.** Security and audit instrumentation
   goes into `build_semantic_sql` / `gateway.run_query` and the auth
   resolvers — the funnels everything already passes through — never
   per-endpoint sprinkles.
2. **Logs are for operators; audits are for compliance.** Two streams,
   two retention policies, one correlation id joining them.
3. **Never log data.** Row values, filter values, member names and tokens
   never enter a log line. Field REFERENCES and query ids are fine.
4. **Every phase ships green.** 718 backend + 470 frontend tests stay the
   floor; each task adds its own.

## 3. Workstream A — Security hardening

### Phase A1 (P0)

- **A1.1 Security-header middleware.** `app/main.py`: add middleware
  setting `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  same-origin`, `X-Frame-Options: DENY`, `Cache-Control: no-store` on
  `/api` + `/auth`, and (behind a settings flag, on when
  `environment=production`) `Strict-Transport-Security`. CSP for the SPA:
  `default-src 'self'` with the exceptions Vite's build actually needs,
  delivered via the reverse-proxy doc AND a fallback header. *Accept:*
  header assertions in a route test; SPA loads under the CSP.
- **A1.2 Login throttling.** `app/auth/dev.py` + `connect_token.resolve`
  + XMLA/feed 401 paths: per-IP+username sliding-window limiter
  (in-process token bucket table; interface allows a Redis backend
  later). Lockout responses are 429 with no user-existence signal.
  *Accept:* tests for allow→throttle→recover; auth failures audit-logged
  (A3.2).
- **A1.3 CSRF decision, implemented.** Document and enforce: JSON-only
  APIs + SameSite=lax + a custom-header requirement (`X-Requested-With`)
  on state-changing routes, rejected when absent. Exempt: `/xmla` and
  `/api/feed` (Basic-token, no cookies). *Accept:* forged-form test fails
  cross-origin, normal SPA flows pass.
- **A1.4 Production guardrails in `config.py`.** In
  `environment=production`: refuse `auth_mode=dev` unless
  `SEMANTICUI_ALLOW_DEV_AUTH=1`, refuse `SEMANTICUI_XMLA_TRACE`, require
  `database_url` not to be the localhost default. *Accept:* config tests.
- **A1.5 Credential hygiene closure.** Rotate the Snowflake dev password
  (user action, still open); add `detect-secrets` baseline + pre-commit;
  CI secret scan (D1.2). *Accept:* scan runs clean in CI.

### Phase A2 (P1)

- **A2.1 Token & session hardening.** Connect-token: constant-time hash
  compare (it is hash-lookup today — verify and test), optional IP-pin
  setting; session cookie rotation on privilege-relevant changes; logout
  invalidates connect token explicitly (today: implicit via session
  delete — add a test that proves it).
- **A2.2 Input ceilings.** Explicit request-size limits (FastAPI/uvicorn
  `--limit-request-*`), max filter counts and value lengths in
  `reports/schema.py` (some exist — sweep and close), XMLA statement
  length cap in `soap.py`.
- **A2.3 Dependency floor→lock.** See D1.3 (shared task).
- **A2.4 Threat model doc.** STRIDE pass over the four client paths;
  lives in `docs/architecture/threat-model.md`; reviewed each quarter.
  The XMLA adapter gets its own section (it parses attacker-suppliable
  XML: confirm `defusedxml`-equivalent posture for `ElementTree` use,
  entity expansion off, statement caps).

### Phase A3 (P2)

- **A3.1 SSO for the enterprise.** OAuth mode exists; add OIDC discovery
  + group-to-workspace mapping so workspace membership can be
  IdP-driven. *Accept:* login via a test IdP; group sync job covered.
- **A3.2 Anomaly hooks.** Emit audit events (B/C stream) for: N failed
  logins, token minted, token used from a new IP, export larger than
  configurable rows. Alerting is the deployment's SIEM's job — we emit,
  they consume.

## 4. Workstream B — Logging

- **B1 (P0) Central logging config.** `app/logging.py`: JSON lines to
  stdout (12-factor; collectors ship them), fields `ts, level, logger,
  msg, request_id, user_id, session_id(hash), path, status,
  duration_ms`. Uvicorn/access logs routed through it. Kill the ad-hoc
  per-module handlers (e.g. `xmla/routes.py`'s own StreamHandler).
  *Accept:* one log line per request in tests via caplog; no print()
  anywhere in `app/`.
- **B2 (P0) Request middleware.** Generates/propagates
  `X-Request-ID` (honours inbound header from the proxy), stamps it into
  a contextvar all loggers pick up, times the request, logs one summary
  line. `/xmla` included — the request id also goes into the wire-trace
  markers so a trace file and the log join.
- **B3 (P1) Query logging.** In `gateway.run_query`: log field refs (not
  values), row count, duration, `sfqid`, truncated flag at INFO;
  parameters never logged. The Snowflake query id is the bridge into
  Snowflake's own `QUERY_HISTORY` for full-fidelity forensics.
- **B4 (P1) Log hygiene tests.** A test that greps captured logs for
  token prefixes (`xlt_`), password fields and bound values in
  representative flows — the "never log data" principle as a regression
  test, not a convention.

## 5. Workstream C — Traceability & audit

- **C1 (P0) Audit events table + writer.** New `audit_events` table
  (alembic 0006): `id, ts, request_id, user_id, session_id, action,
  resource_type, resource_id, outcome, detail(JSON, value-free)`.
  Synchronous insert in the same DB transaction where one exists;
  best-effort with error logging where not. Actions, first tranche:
  `auth.login`, `auth.logout`, `auth.login_failed`, `token.mint`,
  `token.used_new_session`, `report.create/update/delete`,
  `report.read`, `export.xlsx/odc`, `feed.read`, `xmla.session_open`,
  `workspace.member_add/remove/role_change`.
  *Accept:* per-action tests; a `report.read` by a non-member records
  `outcome=denied` with no resource-name leakage.
- **C2 (P1) Audit query API + retention.** `GET /api/audit`
  (workspace-admin scoped, filterable by actor/action/time), retention
  sweeper honouring `SEMANTICUI_AUDIT_RETENTION_DAYS`. Export as CSV for
  auditors (through the existing formula-guard).
- **C3 (P1) End-to-end correlation.** request_id → audit row →
  log line → `sfqid` → Snowflake QUERY_HISTORY. Documented as a runbook
  in `docs/architecture/observability.md` with one worked example.
- **C4 (P2) Definition versioning.** Report saves keep the previous
  definition (single-slot undo or full history table) so "who changed
  what" has a diffable answer. Weigh storage; JSON diff in the audit
  detail may be enough.

## 6. Workstream D — Maintainability & delivery

- **D1.1 (P0) CI pipeline.** `.github/workflows/ci.yml`: backend pytest,
  frontend vitest + `tsc --noEmit`, ruff + eslint, on every push/PR.
  *Accept:* red build blocks merge; badge in README.
- **D1.2 (P0) Scanning in CI.** `pip-audit` + `npm audit
  --omit=dev` (fail on high), `gitleaks` secret scan, weekly scheduled
  run so new CVEs surface without a code change.
- **D1.3 (P0) Lockfiles.** Backend: `uv lock` (or pip-tools) committed;
  frontend already has `package-lock.json` — enforce `npm ci` in CI.
  Upgrades become deliberate PRs.
- **D2.1 (P1) Lint/format baseline.** ruff (rules: E,F,I,B,S — S is
  bandit-in-ruff) + eslint strictening; format with ruff-format/prettier;
  one cleanup commit, then CI-enforced.
- **D2.2 (P1) Module health pass.** `BuilderPage.tsx` (~1300 lines) split
  along its seams (page ops, drag routing, selection) — the seams already
  exist as functions; `xmla/execute.py` `_Engine.execute` decomposed
  (axis building and cell resolution as named methods). No behavior
  change; the existing tests are the harness.
- **D2.3 (P1) Error taxonomy.** One `ApiError` catalogue doc; verify no
  handler leaks internals (`errors.py` already strips pydantic input —
  add a test asserting 500s carry no stack traces to clients).
- **D3 (P2) Release engineering.** Versioned container build (backend +
  built SPA behind one server), SBOM generation (syft) attached to
  releases, CHANGELOG discipline, staging smoke script (the COM-driven
  Excel checks, packaged as an opt-in workflow).

## 7. Compliance mapping (pragmatic)

| Control family | Covered by |
| --- | --- |
| Access control (ASVS V4) | Existing RBAC + A1.2/A2.1 + C1 audit of denials |
| Authentication (V2) | Session/TTL today + A1.2 throttle + A3.1 SSO |
| Session management (V3) | Existing cookie flags + A2.1 |
| Input validation (V5) | Bound params today + A2.2 ceilings + B4 hygiene tests |
| Cryptography at rest (V6) | Fernet for OAuth tokens; hashes for connect tokens; document key rotation for `SECRET_KEY` in the threat model |
| Logging & monitoring (V7) | Workstreams B + C entirely |
| Data protection (V8) | No-data-in-logs principle (B4), export guards, no result caching |
| Communications (V9) | TLS at the proxy + HSTS (A1.1) + docs |
| Supply chain | D1.2 scanning + D1.3 lockfiles + D3 SBOM |

SOC 2 readiness note: C1/C2 (audit trail + retention) and D1 (change
management via CI) are the two items auditors ask for first; both are P0/P1
here on purpose.

## 8. Phasing and effort

| Phase | Contents | Effort (focused sessions) |
| --- | --- | --- |
| P0 | A1.1–A1.5, B1, B2, C1, D1.1–D1.3 | 3–4 |
| P1 | A2.*, B3, B4, C2, C3, D2.* | 4–5 |
| P2 | A3.*, C4, D3 | 3–4 |

Order within P0: D1.1 (CI) first — every later task lands with its tests
enforced; then B1/B2 (logging+request-id) because C1 (audit) wants the
request id; then A1.x in any order; C1 last in P0 so it lands on the
correlation rails.

## 9. Definition of "enterprise ready"

The program is done when all of these are demonstrably true:

1. A denied report access, a token mint and an Excel refresh can each be
   traced from audit row → request id → log line → Snowflake query id,
   following the runbook, in under five minutes.
2. CI blocks merges on tests, lint, type-check, dependency CVEs (high+)
   and leaked secrets; builds are reproducible from lockfiles.
3. A fresh deployment with `environment=production` refuses to start
   with any default secret, dev auth, or trace flags.
4. Brute-forcing any auth surface trips a 429 and an audit event.
5. No log line anywhere contains a token, password, or data value —
   and a test proves it.
6. The threat model exists, names the XMLA parser and the four client
   paths, and has an owner and a review date.
