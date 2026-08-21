# Security

The threat model, the controls, and — at the end — the things that are
known to be weak. That last section is the point of writing this down:
a security document that lists only strengths is a marketing document.

Last reviewed: 2026-08-20, against the code at that date.

---

## 1. The property everything rests on

**Every query runs on the caller's own Snowflake connection.**

There is no service account and no shared credential. A user's session
holds a connection authenticated as *them*, and every statement — a
report's query, an Excel refresh, a Cortex call — goes down it.

Three consequences, and they are the whole security posture:

1. **This app cannot widen anybody's access to data.** If Snowflake
   refuses a user a table, the refusal arrives here in Snowflake's own
   words. There is no path by which the app reads something the user
   could not have read themselves.
2. **Sharing shares definitions, never numbers.** A report is a document:
   which fields, which filters, which layout. Two people opening the same
   report can legitimately see different rows, because they are two
   different Snowflake identities asking.
3. **Snowflake's own audit trail stays truthful.** `QUERY_HISTORY`
   attributes every statement to the person who caused it, not to a
   service account, so an organisation's existing controls keep working.

Result sets are never cached across users. There is a per-session
connection cache, keyed by session, and a describe cache holding *model
metadata* — table and column names the user has already been granted.

---

## 2. Authentication

**Single sign-on is the way in.** Snowflake External OAuth (Entra ID,
Okta, any OIDC provider) or Snowflake's built-in OAuth. Setting it up is
[docs/operations/snowflake-sso.md](operations/snowflake-sso.md) —
registration, security integration, and every trap the setup actually
hit.

The backend is a **confidential client**: it performs the authorization
code exchange and keeps the token server-side, encrypted. The browser
never holds a Snowflake token at all.

- **PKCE** on the authorization code exchange.
- **`state`** is single-use, time-bounded, and carries the chosen account
  so a rebuilt connection cannot land on a different one.
- The **default install offers nothing else.** Direct Snowflake
  credentials appear only where a deployment names them explicitly, and
  configuration refuses anything but key-pair in production. Dev auth mode
  keeps all three, because it exists to have a way in without an IdP.
- The endpoint refuses what the login page does not offer — the two read
  the same resolved list, so a hidden form is not a hidden capability.

**Session cookie**: `HttpOnly`, `SameSite=Lax`, and `Secure` outside dev
mode.

**Tokens at rest**: OAuth access and refresh tokens are encrypted with
Fernet before they touch the database. Connect tokens are stored only as
a SHA-256 digest — presenting the raw token is the only way to use one,
and it is shown exactly once.

**Throttling**: failed sign-ins are rate-limited per client *and* per
account/user pair, so one person's typo cannot lock out an office behind
a shared NAT. A refusal for rate is itself recorded, which is what the
security board watches for. The connect-token endpoint is throttled the
same way.

"Per client" means the address the ASGI server reports, and behind a
reverse proxy that is the *proxy's* address unless the server is
configured to trust `X-Forwarded-For` — at which point the property above
inverts and one person's typos throttle everybody. Deployments must set
it; [operations/aws-ecs-deployment.md](operations/aws-ecs-deployment.md)
does, and explains why doing so is safe only when the app's port is
reachable from the proxy alone.

---

## 3. Authorization

**One gate.** `require_owned` / `require_access` resolve any
workspace-owned row to its workspace, then to the caller's membership,
then to the role required. Every read and write of a report, dashboard or
explore goes through it. `owner_user_id` is provenance and is *never*
consulted for access, so removing somebody from a workspace actually
removes their access.

**Roles**: viewer reads, editor creates and changes, admin also manages
members. The last admin of a workspace cannot be removed or demoted.

**404, not 403, for things you may not see.** A stranger asking for a
report id gets "not found", because "forbidden" tells them the id exists.
The exception is the admin area, which answers 403 with a reason: there is
nothing to hide about its existence, and an operator left off the list
needs telling rather than an empty page.

**App administrators come from the environment**, not the database
(`SEMANTICUI_APP_ADMINS`). A permission to read everyone's activity and
broadcast to every user is not one anybody inside the app should be able
to grant themselves.

**Cross-workspace containment**: a dashboard tile may only name a report
in the dashboard's own workspace, checked on pinning *and* on every
update — an update is the one place a client could smuggle one in.
Without it a dashboard could show a report half its members cannot open.

**A model over several views adds no trust boundary.** Its members are
semantic views — warehouse objects with their own grants, not
workspace-owned rows — so membership governs who may edit the *mapping*
and Snowflake alone governs the data. Every branch of a composite query
runs on the caller's own connection against the member views, so a model
naming a view somebody cannot read refuses them in Snowflake's own words.
Constraining which views a model may name would have been this app
inventing an access rule Snowflake did not ask for, and would have
implied a containment it cannot actually provide.

**Readability probes are not authorization decisions.** Drawing a list
asks "may this person open this?" for many rows at once. That reads
membership directly rather than calling the acting gate, which would
record an audited refusal — and commit it — every time a page merely
rendered. A test holds the two answers together across every case so they
cannot drift.

---

## 4. Injection and untrusted input

- **SQL**: every identifier passes through `quote_ident`, which validates
  and rejects embedded quotes; every *value* is bound as a parameter and
  never reaches SQL text. A model over several views compiles to one
  statement whose parameters are assembled in the same pass as its SQL,
  so positional binding cannot drift — an off-by-one there would bind
  one filter's value to another's placeholder and still succeed, which is
  the worst failure this product has.
  `USE ROLE` / `USE WAREHOUSE` cannot take a bind in Snowflake, so those
  interpolate a validated, quoted identifier.
- **Derived metrics are an expression tree, not a formula string.** A
  model's cross-view arithmetic is a closed AST of four operators, metric
  references and numbers; a submitted string is refused as a shape error
  rather than parsed.
- **The semantic layer is the allow-list.** A field reference that is not
  in the model's own describe output is refused before a query is built.
- **XSS**: React escapes by default and the codebase contains no
  `dangerouslySetInnerHTML`. Values that reach a `style` attribute or a
  class name — a canvas colour, an announcement level, a stored column
  width — are validated against a pattern or an enum first.
- **Excel formula injection**: a cell whose value begins `= + - @` is
  neutralised on export.
- **XML injection over XMLA**: element text and attribute values are
  escaped by different rules, and the difference is load-bearing. The
  standard-library escaper leaves quotes alone, which is right for text
  and wrong inside an attribute, where a bare `"` ends the value early.
  One helper escapes attributes, and the tests assert that responses
  *parse* rather than that they contain entities — including a SOAP
  fault whose message carries a quote, which is what a client sees when
  anything else has already gone wrong.
- **Prompt injection**: the model proposes a query specification. It never
  executes one and never sees data; the resulting SQL is always shown.
- **Document size** is bounded on every import and save, checked on the
  raw payload before parsing.

---

## 5. Transport and browser hardening

Set on every response: `Strict-Transport-Security` (outside dev),
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: same-origin`, and a `Content-Security-Policy`.

Cross-site requests are refused. Access-token query strings never reach
the logs — the access logger is detached from the root handler precisely
so they cannot.

---

## 6. Audit

Recorded at the funnels, not sprinkled through business logic:
authentication, the authorization gate, every create/read/update/delete
of a report, dashboard or explore, every membership change, every query
run, token mints, exports, XMLA sessions, admin refusals, announcements.

**Value-free by contract.** `detail` holds shapes — counts, flags,
durations, ids — never a data value, a resource name, a filter, or a
token. Sessions appear as a SHA-256 prefix, so the trail correlates one
person's actions without becoming worth stealing. This is what makes it
safe to render the log verbatim to an operator.

Two contracts that are easy to lose and are tested:

- The writer **swallows its own errors**. A broken audit database must not
  take the product down; the gap is logged loudly instead.
- A test enumerates every action the app should write and greps for each,
  because four subsystems once went unaudited until somebody noticed the
  log looked thin.

---

## 7. Dependencies

`pip-audit` and `npm audit` (including dev dependencies) both report
**0 known vulnerabilities** as of the review date. Licences were checked
when dependencies were added; `elkjs` was rejected for a GPL-or-EPL dual
licence and `@dagrejs/dagre` (MIT) used instead.

Run both before a release:

```bash
cd backend  && python -m pip_audit
cd frontend && npm audit
```

---

## 8. Known weaknesses

These are real and unfixed. They are listed because an operator deciding
whether to deploy this needs them.

| # | Weakness | Consequence | Notes |
|---|---|---|---|
| 1 | **Token encryption key is a bare SHA-256 of the secret** — no salt, no KDF (`app/auth/crypto.py`). | A weak `SEMANTICUI_SECRET_KEY` is brute-forceable offline by anybody holding a database dump. | Mitigated today by requiring a long, non-default secret in production. Fixing it properly (PBKDF2/scrypt with a stored salt) **invalidates every stored OAuth token** and forces re-authentication, so it needs a deliberate migration. |
| 2 | **`SameSite=Lax` does not isolate sibling subdomains.** | Something on another host under the same registrable domain can carry the session cookie on top-level navigations. | Deploy on a dedicated hostname, or add `__Host-` prefixed cookies and an origin check. |
| 3 | **No throttle on `/auth/login`** (the SSO redirect start). | The IdP redirect can be requested in a loop. It mints no session and touches no credential, so the cost is IdP traffic rather than an authentication risk. | |
| 4 | **No SAST in CI.** | Regressions in the above are caught by review and tests only. | Semgrep or CodeQL is the obvious addition. |
| 5 | **Listings are bounded, not paginated.** | A workspace with more than 200 items shows the first 200 and says so. | Deliberate: the merged browse draws from three sources and a page number across three lists means nothing. Revisit if a workspace legitimately holds thousands. |
| 6 | **A real Snowflake account identifier appears in docs and fixtures.** | Not a credential, but it names a real account in a public repository. | Worth scrubbing before wider publication. |
| 7 | **Explores cannot be moved between workspaces.** | An explore saved into the wrong workspace has to be recreated. | Reports have a move panel; explores do not yet. |
| 8 | **Sign-in throttling and the OAuth `state` store are per process** (`app/auth/throttle.py`, `app/auth/oauth.py`). | Across N replicas the throttle allows N times the attempts, and a sign-in started on one replica cannot complete on another. | Both belong in Postgres beside the session rows. Until then a multi-replica deployment needs sticky sessions, which pins a browser but not an attacker — see [operations/aws-ecs-deployment.md](operations/aws-ecs-deployment.md). |

---

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public
issue. Include the request id from the response if you have one — it joins
the application log to Snowflake's `QUERY_HISTORY` and usually makes a
report reproducible in one step.
