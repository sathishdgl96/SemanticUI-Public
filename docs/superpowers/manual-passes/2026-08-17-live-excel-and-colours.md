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

## The corruption, and what caused it

**Excel rejected the first workbook this shipped.** The cause was one
namespace. A `.rels` part has two in play: the `<Relationships>` container
belongs to the PACKAGE namespace
(`…/package/2006/relationships`), while the `Type` on each relationship inside
it belongs to the officeDocument one (`…/officeDocument/2006/relationships`).
The builder used the officeDocument URI for both.

The result was a file that was well-formed XML, whose every `Target` resolved
to a part that existed, and which told Excel the worksheet declared no
relationships at all — so `<tablePart r:id="rId1"/>` pointed at nothing and the
package was rejected.

Every structural test written for this passed on that file, because they
matched raw text with regular expressions, and a regex cannot tell one
namespace from another. `TestRelationshipNamespaces` parses instead, and was
confirmed to fail on the broken build before the fix was restored: reintroduce
the wrong namespace and three tests go red.

A rebuilt workbook now reads consistently namespace-aware: every `.rels`
container in the package namespace, and every `r:id` a worksheet uses declared
in that worksheet's own rels.

## Resolved on 2026-08-18, in real Excel on this machine

The workbook now OPENS in Excel, verified by COM automation: the data sheet
carries a genuine query table (`sourceType=3` / xlSrcQuery, a live
QueryTable object) bound to a connection holding the SEMANTIC_VIEW SQL.

The corruption had THREE layers, found in this order:

1. **The rels namespace** (fixed 2026-08-17): the `<Relationships>` container
   belongs to the package namespace, not the officeDocument one.
2. **A probe artifact that poisoned the bisect**: test tables named "Q1" --
   a legal identifier that is also a cell reference, which Excel rejects
   outright. Half a day of "even a plain table fails" evidence was this.
   `_table_name` now refuses cell-reference-shaped names.
3. **The real fault: a hidden defined name.** A table with
   `tableType="queryTable"` is resolved through a hidden `definedName` in
   workbook.xml (queryTable name -> its range, `localSheetId` = the sheet's
   POSITION in workbook order, not its sheetId). Diagnosed decisively by
   transplanting Excel's own authored parts into this workbook and watching
   them fail without it -- the reference query table was authored by driving
   Excel itself against the built-in Access Text ODBC driver.

## What is STILL not verified

**A real refresh against Snowflake.** The file is assembled by editing
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
