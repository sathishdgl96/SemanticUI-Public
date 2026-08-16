# Manual pass — workspaces and sharing (sub-project 3)

**Date:** 2026-08-16
**Build:** `feature/foundation` at `6d81d22` plus the fixes below
**Account:** `xriieim-eh01350`
**Driver:** Chromium via Playwright, 1440×900

## What kind of pass this was

**Unstubbed.** The browser talked to the real backend, which talked to real
Snowflake. No `page.route` calls anywhere in the driver.

The `0003` migration also ran against the **real dev database** with real data
in it, not only against the scratch SQLite files the migration tests use.

## What it found

**A horizontal overflow at 390px.** Adding the workspace switcher to the
reports header pushed `.reports-actions` past the viewport — it was a flex row
that never wrapped, and had only fitted before because the header was emptier.
Fixed by letting both `.reports-head` and `.reports-actions` wrap.

**Two `<label>`-wrapped `<select>` elements with unusable accessible names.**
Wrapping a label around a select folds the *option text* into the control's
accessible name, so the workspace switcher announced as
"WorkspaceMy reportsTeam" and each role control as
"Role for BOBviewereditoradmin". Testing Library's label matching is forgiving
enough to hide this; a real browser is not. Both now use explicit
`htmlFor`/`id`. This was found only because the driver could not locate the
control a passing unit test located easily.

**A dev database left in a half-migrated state** — carrying the `0003` tables
at revision `0002` — because the migration tests had run against it before
`env.py` stopped overriding `sqlalchemy.url`. Cleaned up and re-migrated
properly; the backfill then moved both existing reports into their owner's
personal workspace with them as admin, which is the migration working on real
data rather than on a fixture.

## Steps and results

Run on a clean database (leftover `Team` workspaces from earlier runs removed
first — see "A note on repeated runs" below).

| # | Step | Result |
|---|---|---|
| 1 | Sign in | Only "My reports"; both migrated reports visible in it |
| 2 | Create workspace "Team" | Created; "You are an admin here" |
| 3 | Create a report in Team | Team shows 1, My reports still 2 — **scoping proven** |
| 4 | Open Members | 1 member; Remove disabled with the last-admin reason |
| 5 | Add `COLLEAGUE_TEST` as editor | 2 members; self-removal **still** disabled |
| 6 | Promote them to admin | Self-removal now **enabled** |
| 7 | Switch to My reports | No Members control at all |
| 8 | Open the report, click Move | Offers "My reports" and "Team" |
| 9 | 1440 / 1280 / 1024 / 768 / 390px | No horizontal overflow at any width |

Final state: **no page errors, no failed API calls.**

Steps 4→6 are the interesting sequence: the last-admin lock holds while there
is one admin, holds after a *non*-admin joins, and releases at exactly the
moment a second admin exists. That is the rule behaving as a rule rather than
as a disabled button someone remembered to add.

## A note on repeated runs

An earlier run left three `Team` workspaces behind, and the driver then picked
the oldest one — which already had a second admin from the previous run, so
the last-admin assertions read as failures. They were not: the product was
correct and the *fixture* was dirty. The same run also logged a
`400 POST /members`, which was the duplicate-member guard firing correctly on
a colleague added by the previous run.

Recorded because a dirty fixture producing plausible-looking failures is
exactly the kind of thing that gets "fixed" in the wrong place.

## What this pass did NOT cover

Stated plainly rather than implied by omission.

- **A second real Snowflake user.** Every step ran as one login. The
  credential property — that a viewer queries on their own connection and sees
  none of the data their role cannot read — is covered by
  `test_sharing_uses_viewer_credentials.py` with a connection stubbed to
  refuse SELECT, and by `test_sharing_it.py`, which **skips** unless
  `SEMANTICUI_IT_USER_B` is configured. It was not configured, so it skipped.
  A skip is not a pass.
- **Removing yourself from a workspace and losing access to its reports.**
  Covered by `test_a_removed_member_loses_access_to_the_reports`, not driven
  in the browser.
- **Renaming and deleting a workspace through the UI.** The endpoints and
  their guard rails are covered by `test_workspace_routes.py`; there is no UI
  for either yet, which is a gap worth naming rather than hiding.
- **Actually completing a move.** The Move control was opened and its
  destination list verified; the move itself was not submitted in the browser.
  `test_report_move.py` covers the eight cases including both half-permission
  failures.

## Screenshots

`w1-signed-in`, `w2-created`, `w3-scoped`, `w4-members`, `w5-member-added`,
`w6-two-admins`, `w7-personal`, `w8-move`, `w9-{1440,1280,1024,768,390}` —
written to the session scratchpad, not committed.
