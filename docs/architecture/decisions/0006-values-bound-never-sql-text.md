# 0006 — Values are bound, never SQL text

Status: Accepted

## Context

Every query surface accepts user-influenced values: filter values,
member keys, search text, feed parameters, XMLA tuple filters. String
interpolation would make each of them an injection point, and even
"escaped" interpolation leaks values into logged SQL text.

## Decision

Every user-influenced VALUE travels as a bound parameter (`qmark`
style, bound server-side by Snowflake). Identifiers are never bound —
they are validated against the view's live DESCRIBE and pass through
`quote_ident`, which refuses anything containing a quote. SHOW/DESCRIBE
statements, which cannot take binds, accept identifiers only.

## Consequences

- Injection resistance holds even for exotic surfaces (XMLA member
  keys arrive as MDX and still end up as binds — including the
  tuple-IN predicate behind Excel's filter-out).
- SQL text is safe to log because it contains no data; that is what
  makes [0007](0007-value-free-observability.md) workable.
- Tests assert values never appear in generated SQL; a change that
  breaks the contract fails CI, not code review.
