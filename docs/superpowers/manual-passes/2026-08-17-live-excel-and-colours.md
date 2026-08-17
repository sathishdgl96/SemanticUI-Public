# Manual pass — a live workbook, a floating chat, and custom colours

**Date:** 2026-08-17
**Driven against:** the live API and the live Snowflake account. No stubs.

## What prompted it

Five things in one message: an .odc is not an Excel file; the delete control
should be a red icon; the chat should float with an X and be resizable; Excel
and Connect live should be one thing that gives a workbook with data and a
live connection; and report creation needs custom colours, hex included.

## Result

| # | Check | Result |
|---|---|---|
| 1 | One Excel control, not two | 1 Excel button, 1 caret, 0 "Connect live" buttons |
| 2 | It downloads a workbook | `TPCH_SALES_ANALYTICS.xlsx`, 8583 bytes |
| 3 | The workbook carries a connection | `xl/connections.xml` present, 1 table part |
| 4 | …naming the server and the query | `…snowflakecomputing.com` and `SEMANTIC_VIEW` both present |
| 5 | …and no credential | no password / pwd / token anywhere |
| 6 | Delete is a red icon | 🗑, `rgb(180, 35, 24)`, accessible name "Delete &lt;report&gt;" |
| 7 | The chat floats | `position: fixed`, 460×560, canvas still visible behind it |
| 8 | It can be resized | `resize: both` |
| 9 | It closes with an X | "Close chat" button present |
| 10 | Custom series colour by hex | bars drawn magenta after typing `#e2007a` |
| 11 | Tile background by hex | `rgb(255, 244, 229)` |
| 12 | Canvas background by hex | `rgb(16, 24, 32)` |
| 13 | Page errors / failed API calls | none / none |

Screenshots: `F1-delete.png`, `F2-chat.png`, `F3-colours.png`, `F4-canvas.png`.

## Two defects this pass caught

**The workbook had no connection in it at all.** Every step reported success
and `xl/connections.xml` was simply absent. The connection builder finds
sheets *by name*, and Excel caps a sheet name at 31 characters — the title
"CUSTOMER_COUNT by MARKET_SEGMENT" is 32, so the workbook wrote
"CUSTOMER_COUNT by MARKET_SEGMEN" and the lookup found nothing. Silent,
because a sheet that cannot be found is skipped rather than treated as an
error. Both sides now derive names from one `assign_sheet_names` helper, and
that helper runs over *every* sheet including failed ones — filtering them out
would shift each later name by one and attach connections to the wrong tabs.

**The page-level format section was unreachable.** Selecting a visual was
possible; selecting *nothing* was not, so the Canvas colour control could
never be shown. Clicking the canvas itself now deselects, guarded on
`e.target === e.currentTarget` so a click that landed on a tile and bubbled
does not immediately undo the selection it just made.

## What is NOT verified

**Nobody has opened this workbook in Excel.** The file is assembled by editing
a zip of OOXML parts, which is exactly the kind of code that produces "we
found a problem with some content". Excel is not available here, so
`tests/test_export_live.py` checks every structural property that can be
checked without it — the archive opens, every part is well-formed XML, every
part has a content type, every relationship resolves, `tableParts` is the last
child of its worksheet, and openpyxl can still read the result. That is what
stands between a plausible file and a corrupt one; it is not proof.

**Refreshing needs the Snowflake ODBC driver** on the machine that opens the
file. The connection reaches ODBC through MSDASQL. Power Query's own Snowflake
connector needs no driver, but its definition lives in an undocumented binary
part of the .xlsx, which is not something to hand-author. The manual route and
the .odc both remain behind the Excel button's caret for anyone the embedded
connection does not suit.

**The old .odc download is still there**, one click deeper. It was not removed
because it is the fallback if the embedded connection turns out not to open.
