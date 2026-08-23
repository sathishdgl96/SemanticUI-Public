# 0010 — The backend is a confidential client; Snowflake tokens live server-side, encrypted

Status: Accepted

Supersedes: [0004](0004-browser-holds-the-sso-token.md)

## Context

[0004](0004-browser-holds-the-sso-token.md) decided the opposite: the SPA
would be a public client of the IdP, the browser would hold the access
token, and the server would persist nothing for interactive users. The
prize was not being a token vault.

It was never built. Server-side PKCE landed as the first step and the
public-client flow stayed a plan item, while three things about the rest
of the system made the original decision progressively harder to want.

**The vault exists either way.** Excel cannot perform an IdP redirect,
so its delegated grants are persisted and encrypted ([0005](0005-pat-model-excel-tokens.md)).
0004 acknowledged this as "the exception" — but an attacker does not care
whether the token store holds one class of credential or two. The
property 0004 was buying was already gone.

**A browser-held Snowflake token is XSS-exfiltratable.** Any script that
runs in the page can read it and use it directly against Snowflake, from
anywhere, for its full lifetime — outside this app, outside its audit
trail. That is a materially worse failure than the same script riding a
session cookie it cannot read, against an app that records what it does.

**Snowflake's own OAuth requires a confidential client.** It issues a
client secret and expects the exchange to be authenticated. 0004 named
this and accepted losing it, leaving External OAuth as the only possible
IdP. Small deployments that want SSO without standing up an Entra or Okta
registration have no route in under that constraint.

## Decision

The backend performs the authorization code exchange as a **confidential
client**: client secret *and* PKCE verifier. The secret proves the
backend; the verifier proves the exchange belongs to the browser that
started it.

Access and refresh tokens are encrypted with Fernet before they reach the
database. The browser receives one thing: this application's own session
cookie — `HttpOnly`, `SameSite=Lax`, `Secure` outside dev mode. It never
holds a Snowflake token at all.

## Consequences

- **The IdP registration is a Web platform application, not a
  Single-page application.** An SPA-type registration is a public client:
  Entra refuses a client secret on the token call and expects a CORS
  preflight carrying an `Origin` header, and a server-side exchange sends
  a secret and no `Origin`. This is the single most common setup failure
  and is called out in the [runbook](../../operations/snowflake-sso.md).
- **Both OAuth flavours work.** Snowflake built-in OAuth and corporate
  External OAuth differ only in which endpoints are configured; the code
  path is one. This is what 0004 gave up.
- **XSS cannot steal a Snowflake credential.** It can act as the user
  while the page is open, through an audited API, against a session an
  administrator can revoke.
- **The token store is a high-value target, and we accept that.** Fernet
  at rest is the mitigation, and the key derivation behind it is
  [SECURITY.md](../../SECURITY.md) weakness #1 — an unfixed one, named
  because this decision is what makes it matter.
- **"Any replica can serve any request" is not true of what shipped.**
  The per-session Snowflake connection cache and the OAuth `state` store
  are both in process ([0008](0008-in-process-state-with-swap-seams.md)),
  so a multi-replica deployment needs sticky sessions until they move to
  Postgres. 0004 listed the absence of routing affinity as a benefit; it
  is a cost we now pay, documented in
  [operations/aws-ecs-deployment.md](../../operations/aws-ecs-deployment.md).
- Sessions last `SEMANTICUI_SESSION_TTL_HOURS` (default 8) rather than
  bouncing through the IdP roughly hourly, because the refresh token is
  held server-side and used without the user present.
