# Manual pass — the Power Query feed

**Date:** 2026-08-18
**Driven against:** the live API and the live Snowflake account, over HTTP
with real Basic credentials. No stubs.

## What this is

The zero-install Excel path, and the outcome of the XMLA investigation: a
per-visual data URL that stock Excel's built-in Data → From Web refreshes,
authenticated with the caller's OWN Snowflake credentials. No ODBC driver, no
admin rights, no add-in, no undocumented Microsoft handshake — Power Query and
CSV are documented, stable surfaces that Office updates do not break.

    /api/feed/reports/{report}/visuals/{visual}.csv     (and .json)
    ?f.TABLE.FIELD=value      slice from a worksheet cell, any data volume
    ?limit=N                  row cap; X-Truncated header says if it bit

## Result

| # | Check | Result |
|---|---|---|
| 1 | No credentials | 401 + `WWW-Authenticate: Basic realm="SemanticUI feed"` (Excel prompts) |
| 2 | Real credentials, real report | CSV: header + the visual's rows, from a live SEMANTIC_VIEW query |
| 3 | The visual's own stored filters apply | the customer-filtered visual served exactly its filtered rows |
| 4 | URL slice composes with stored filters | `f.CUSTOMERS.MARKET_SEGMENT=MACHINERY` narrowed to zero rows, correctly |
| 5 | JSON variant | columns, typed rows, `truncated` flag |
| 6 | Truncation | `X-Truncated` header present on capped calls |
| 7 | Snowflake login without an app account | 404, indistinguishable from a nonexistent report |
| 8 | Suites | 687 backend / 454 frontend, typecheck clean |

## The bug the live pass caught

The identity match. The app stores the account **locator** (`RC16948`, from
`probe_identity` at login) while the Basic username carries the **org
identifier** used to connect (`xriieim-eh01350`) — one account, two names, and
the first implementation compared them, 404ing every legitimate caller. Fixed
by asking the CONNECTION who it is (`probe_identity`, the same call dev-login
stores from) and matching that. No unit test would have caught it: the fakes
answered whatever identity the test invented. The wire did.

## Security properties, tested

- The Basic credentials open the caller's own Snowflake connection (the XMLA
  session store; repeated refreshes reuse it rather than logging in each time).
- Workspace membership decides report visibility — a valid Snowflake login
  with no app account, or no membership, is a 404 that does not reveal the
  report exists.
- URL filter values are validated against a live DESCRIBE and **bound**, never
  SQL text (asserted at the cursor).
- CSV disarms formula-shaped text values with the same rule as the workbook
  export; `.json` is the byte-exact channel.

## NOT verified

**Excel's own Power Query UI end to end.** The From Web → Basic → load flow is
standard PQ behaviour against a standard 401/Basic/CSV server, but nobody has
clicked through it here: PQ's credential store cannot be pre-seeded from COM
automation without prompts. First human to try it: Data → From Web → paste the
URL from the Connect panel → Basic → username `account/user`.
