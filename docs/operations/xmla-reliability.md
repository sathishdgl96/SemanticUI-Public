# XMLA / Excel Reliability

What makes an Excel connection "break randomly", what the server now
self-heals, and what remains an operator's (or developer's) job. Read
this before filing "Excel stopped working" as a bug.

## The failure funnel

Every intermittent XMLA failure converges on one place: the cached
Snowflake connection behind the user's app session. The connector's
`is_closed()` is a client-side flag — a connection killed server-side
(Snowflake idle timeout, laptop sleep, VPN change, network blip) still
reports open, gets handed out again, and fails the query.

## What the server self-heals (nothing for you to do)

- **Keep-alive**: every connection is opened with
  `client_session_keep_alive`, so Snowflake no longer expires idle
  sessions under a parked pivot table. This removes the most common
  death.
- **Discard-and-retry**: when a query fails with a session-gone error,
  the XMLA endpoint discards the dead connection and retries once.
  OAuth sessions rebuild silently mid-gesture — the user never notices.
- **Clear faults**: when recovery is impossible (dev mode, below), the
  user sees "sign in and create a new connect token", not a generic
  internal error.
- **Throttle forgiveness**: MSOLAP re-sends a rejected token in a
  burst; only distinct bad tokens count against the per-client limit,
  so an expired token can never 429 the fresh one minted to recover.
- **Re-auth on restart**: MSOLAP sends the connect token on every
  request, so a wiped XMLA session map (restart, 15-minute idle sweep)
  re-authenticates transparently — no user action, provided the
  connection itself can be rebuilt (OAuth) or is still alive (dev).

## What still breaks it, and what to do

| Cause | Effect | What to do |
|---|---|---|
| Backend restart, **dev-mode** session | Excel faults with "sign in again" until the user re-logs into the web app | Expected: dev credentials are never stored (ADR 0008). In development, run Excel tests against `docker compose` or a non-reload server — every `uvicorn --reload` file-change restart kills dev connections. |
| Backend restart, **OAuth** session | Nothing — connection rebuilds from the stored grant | — |
| App session expiry / logout | Excel faults with "the app session behind this token has ended" | Expected: revocation-by-session is the security model (ADR 0003). Mint a new token after signing in. |
| Connect token expiry | 401, Excel prompts for credentials | Mint a new token; validity is `SEMANTICUI_CONNECT_TOKEN_TTL_HOURS` (PAT-model custom validity is the planned replacement). |
| Reverse proxy hides client IPs | All users share one throttle bucket; 8 distinct bad tokens per minute across *everyone* lock the bucket | Run uvicorn with `--proxy-headers` (and set `FORWARDED_ALLOW_IPS`) so the real client IP reaches the app. |
| Multiple replicas without session affinity | XMLA re-auth works (token on every request), but each replica opens its own Snowflake connection per session | Supported shape today is single replica or affinity (ADR 0008); K4 is the verification item for anything else. |
| Long queries (> Excel's timeout) | MSOLAP gives up; requests behind the same session's lock queue | Set `SEMANTICUI_STATEMENT_TIMEOUT_SECONDS` below Excel's patience; investigate the query with the request id → query id chain. |

## Diagnosing a report of "Excel broke"

1. Get the timestamp; find the request in the log stream (every XMLA
   request logs verb + request type + session state, with request id).
2. `AUTH_EXPIRED` after a retry → the connection died and could not be
   rebuilt: dev-mode session or revoked OAuth grant. Check
   `audit_events` for the session's history.
3. 429s → look for a burst of distinct bad tokens from that client;
   with proxy-headers misconfigured, "that client" may be everyone.
4. Anything else → `SEMANTICUI_XMLA_TRACE` in development reproduces
   with verbatim wire captures (production refuses the flag); the
   workflow is in CONTRIBUTING.

The regression suite for all of this is
`backend/tests/test_xmla_reliability.py`.
