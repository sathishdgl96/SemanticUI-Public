# 0005 — Excel connect tokens follow the PAT model

Status: Accepted (single-token version live; multi-token page is the next milestone)

## Context

Excel needs a credential that survives longer than a browser session
([0004](0004-browser-holds-the-sso-token.md)). The industry-standard
answer for "a long-lived credential a tool holds on the user's behalf"
is the personal access token as GitHub and Databricks ship it: named,
scoped, expiring, hash-stored, shown once, individually revocable.

## Decision

Excel connect tokens are PATs. Users mint named tokens from a
self-service page; validity is chosen at mint time, capped by an
admin-set maximum that can never exceed 90 days; the server stores
only the sha256 digest plus, per token, the encrypted delegated grant
that lets it reach Snowflake. Each token shows its last-used time and
revokes independently.

## Consequences

- A leaked token has a bounded lifetime and a visible audit trail
  (mint, use, revoke all land in audit_events).
- The 90-day ceiling is a hard product rule, not a default — admins
  can shorten it, never extend it.
- Familiar model: users who have minted a GitHub or Databricks token
  need no training.
- Until the multi-token page ships, the live implementation is one
  token per session with TTL from `connect_token_ttl_hours` — the
  storage rules (hash-only, shown once) already match this ADR.
