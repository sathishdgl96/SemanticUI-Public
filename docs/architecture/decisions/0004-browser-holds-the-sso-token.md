# 0004 — The browser holds the SSO token; the server persists nothing for it

Status: Accepted (server-side PKCE landed; SPA public-client flow is plan item S2)

## Context

Production auth is SSO through the corporate IdP with Snowflake
External OAuth ([runbook](../../operations/snowflake-sso.md)). The
question was where tokens live. Server-side storage makes the server a
token vault — the highest-value thing to steal. Sticky per-user
containers were considered and rejected: routing affinity complicates
scaling and still leaves tokens in server memory.

## Decision

The SPA is a public client of the IdP (authorization code + PKCE, no
client secret). The browser holds the short-lived access token and
refreshes it through the IdP's SPA rotation policy. The server stores
nothing for browser clients; after about an hour of inactivity the
next click bounces silently through the IdP.

## Consequences

- No server-side token store to breach for interactive users; any
  replica can serve any request (no routing affinity).
- Excel is the exception: a spreadsheet cannot do an IdP dance, so its
  delegated grants are the ONLY credentials the server persists —
  encrypted, per-token, revocable ([0005](0005-pat-model-excel-tokens.md)).
- Snowflake-native OAuth could not be used for the browser path: it
  issues a client secret and expects a confidential client. External
  OAuth is what makes the public-client pairing work.
