# Architecture Decision Records

The decisions that shape this codebase, each with the context that
forced it and the consequences we accepted. Read these before proposing
a change that touches one — "why is it like this?" should never require
archaeology through commit history.

Format: one decision per file, numbered in the order they were made.
A superseded decision is never deleted; it gets a `Superseded by` line.

| # | Decision |
|---|----------|
| [0001](0001-own-connection-only.md) | Every query runs on the caller's own Snowflake connection |
| [0002](0002-first-party-xmla-endpoint.md) | Excel connects through a first-party XMLA endpoint |
| [0003](0003-connect-tokens-ride-app-sessions.md) | External clients ride app sessions via connect tokens |
| [0004](0004-browser-holds-the-sso-token.md) | The browser holds the SSO token; the server persists nothing for it |
| [0005](0005-pat-model-excel-tokens.md) | Excel connect tokens follow the PAT model |
| [0006](0006-values-bound-never-sql-text.md) | Values are bound, never SQL text |
| [0007](0007-value-free-observability.md) | Logs and audit events are value-free |
| [0008](0008-in-process-state-with-swap-seams.md) | In-process state, with seams to swap it out |
| [0009](0009-role-is-a-facet-not-a-boundary.md) | A Snowflake role is a facet, not a boundary |
