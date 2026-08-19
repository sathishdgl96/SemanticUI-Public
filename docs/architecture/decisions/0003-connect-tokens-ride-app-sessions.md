# 0003 — External clients ride app sessions via connect tokens

Status: Accepted

## Context

Excel and feed clients need the user's Snowflake connection ([0001](0001-own-connection-only.md))
but must never hold Snowflake credentials: a password in an Excel
connection dialog gets saved to the workbook, synced, and shared. An
early design had adapters connecting to Snowflake directly; it was
rejected explicitly — external clients must come through the API.

## Decision

The signed-in app UI mints a connect token (`xlt_` prefix, shown once,
stored only as a sha256 digest). External clients present it as the
Basic-auth password. The token resolves to the app session, whose
cached connection runs the queries (`app/xmla/state.py`).

## Consequences

- One auth funnel: the adapters inherit the session's user, workspace
  rights, and connection — no second identity system.
- Revocation is the session lifecycle itself: logging out disconnects
  Excel. That is a feature, not a bug.
- A leaked token is useless once its session ends, and the server
  never stores anything that could reproduce it.
- Token lifetime and naming are evolving into the PAT model — see
  [0005](0005-pat-model-excel-tokens.md).
