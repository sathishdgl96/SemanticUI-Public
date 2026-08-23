# 0001 — Every query runs on the caller's own Snowflake connection

Status: Accepted

## Context

The product is enterprise reporting over Snowflake semantic views.
Snowflake is where the organisation already enforces who may see what:
roles, row access policies, masking, and QUERY_HISTORY attribution. A
service account would flatten all of that into one identity and force
us to rebuild authorization — imperfectly — in the app.

## Decision

There is no service account. Every query, on every surface (web UI,
export, feed, XMLA/Excel), executes on a connection opened with the
calling user's own Snowflake identity.

## Consequences

- Snowflake's own controls apply unchanged; QUERY_HISTORY names the
  real user, which auditors can verify independently of our logs.
- Query results can never be cached across users; the connection cache
  is strictly per app session (`app/snowflake/provider.py`).
- External clients need a way to reach the user's connection without
  holding Snowflake credentials — that problem is solved by [0003](0003-connect-tokens-ride-app-sessions.md).
- Anything that would introduce a shared credential is an architecture
  conversation, not a PR (house rule #1 in CONTRIBUTING).
