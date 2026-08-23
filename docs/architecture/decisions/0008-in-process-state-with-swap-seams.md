# 0008 — In-process state, with seams to swap it out

Status: Accepted

## Context

Three pieces of runtime state live in process memory: the Snowflake
connection cache (necessarily — connections are sockets), the XMLA
session-id map, and the auth throttle windows. External stores (Redis)
would add an operational dependency the current deployment shape does
not need, and the throttle in particular must keep working when the
database is the thing under attack.

## Decision

Keep runtime state in process, behind deliberately small interfaces
(`ConnectionCache`, `SessionStore`, `SlidingWindow`) so a shared-store
implementation can replace each without touching call sites.

## Consequences

- Single-replica (or session-affine) deployment is the supported shape
  today; the two-replica affinity-free verification is plan item K4.
- A restart empties all three. OAuth sessions self-heal (connections
  rebuild from stored grants; XMLA re-auths transparently because
  MSOLAP sends the token on every request). Dev-mode sessions cannot
  self-heal — the credential was never stored — so a backend restart
  in development disconnects Excel until the user signs in again.
  Accepted: it is the flip side of never storing dev credentials.
- The throttle is per-process: N replicas multiply the effective
  limit by N. Acceptable at small N; the Redis swap fixes it at scale.
