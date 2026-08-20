# 0004 — The browser holds the SSO token; the server persists nothing for it

Status: Superseded by [0010](0010-confidential-client-server-side-tokens.md)

**Never implemented.** Server-side PKCE landed as the first step; the SPA
public-client flow that the rest of this record describes did not, and
0010 decided against it. What ships is a confidential client that holds
encrypted tokens server-side — the opposite of the Decision below. This
record is kept for the reasoning, which 0010 answers point by point.

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
