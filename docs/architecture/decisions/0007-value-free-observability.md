# 0007 — Logs and audit events are value-free

Status: Accepted

## Context

The platform moves other people's business data. Logs and audit tables
outlive queries, get shipped to log aggregators, and are readable by
operators who have no Snowflake grant to the underlying data. One
logged filter value or row value quietly widens who can see the data —
without any access decision being made.

## Decision

Observability records SHAPES, never values: field references, row
counts, durations, query ids, resource ids, outcome flags. Never row
values, filter values, resource names, tokens, or passwords. Audit
events reference sessions by hash. A denied access records that a
denial happened to a resource id — not what the resource was called.

## Consequences

- An operator can trace any request (request id → log stream → audit
  row → Snowflake query id → QUERY_HISTORY) without ever seeing data.
- Debugging data-dependent issues requires reproducing with the
  Snowflake query id in Snowflake itself, where access is governed.
- `tests/test_logging.py` runs real flows and greps captured logs for
  leaks; the rule is enforced, not aspirational.
