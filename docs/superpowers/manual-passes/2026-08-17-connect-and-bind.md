# Manual pass — a downloadable connection, and two bugs behind it

**Date:** 2026-08-17
**Driven against:** the live API and the live Snowflake account. No stubs.

## What prompted it

"I already selected the semantic view" — and Chat still said the report was
unbound. And: "can I directly download the connected Excel with the query?",
against a panel that gave four manual steps.

## Result

| # | Check | Result |
|---|---|---|
| 1 | A new report offers the view picker | shown |
| 2 | Picking a view enables Chat immediately | yes |
| 3 | …and it SURVIVES a reload from the server | picker gone, Chat still enabled |
| 4 | The Connect panel offers a file | "Download .odc" per query |
| 5 | The file downloads with a useful name | `CUSTOMER_COUNT by MARKET_SEGMENT.odc`, 1012 bytes |
| 6 | It carries the server | `…snowflakecomputing.com` present |
| 7 | It carries the whole query | `DIMENSIONS "CUSTOMERS"."MARKET_SEGMENT" METRICS …` |
| 8 | It carries no credential | no password / pwd / token anywhere in the file |
| 9 | Page errors / failed API calls | none / none |

Screenshots: `O1-bound.png`, `O2-connect.png`.

## The bug behind the question

Choosing a view changed **local state only**. Everything server-side reads the
report's stored view, so Chat, Excel and Connect all said "not bound" for a
report that plainly showed a view on screen. Pressing Save first was the way
through, and nothing said so. Binding now saves at the moment it happens; the
check above reloads from the server, because anything short of that would have
passed before the fix too.

## The bug the screenshots caught

Check 7 failed on the first run: the connected query had a `METRICS` clause and
no `DIMENSIONS`, and the report was a card reading 150,000 rather than the bar
chart the steps should have produced. The dimension had never reached the well.

The cause was a CSS change made earlier the same day. The field panel's
keyboard hint was hidden until `.field-panel:focus-within`. **`:focus-within`
fires on a mouse click**: pressing a field row focused it, the hint took 38px
of the layout, the list jumped down, and the mouseup landed on a different
element — so no click event fired at all. **The first field you clicked in the
explorer did nothing.** The second worked, because by then the hint was already
open and nothing moved.

Now keyed on `:has(.field-row:focus-visible)`, which a click does not set and
which is also exactly who the hint is for. Verified: one click on a dimension
now puts one chip in Group by, and tabbing still reveals the hint (231×38).

**No unit test can catch this.** jsdom applies no stylesheet and computes no
layout, so every assertion about that click passed while the click did nothing
in a real browser. The guard is the browser pass, and specifically the habit of
following an oddity in a screenshot — a card where a bar was expected — instead
of trusting a green suite.

## About the .odc route

**What it is:** an Office Data Connection file. Excel opens it and creates a
live-connected table, refreshing straight from Snowflake.

**What it needs:** the Snowflake **ODBC driver** on the machine that opens it.
ODC reaches ODBC through the MSDASQL OLE DB provider. Without the driver Excel
reports one it cannot find — which is why the manual route is still in the
panel, folded away, with that difference stated.

**What it does not contain:** any credential. Excel prompts for a sign-in, so
the workbook refreshes as whoever opened it. That is the same rule the whole
product runs on, and a file carrying a password would break it the first time a
workbook was forwarded. `tests/test_connect_odc.py` asserts the file contains
no password, pwd, uid, token or authenticator.

**Not covered:** nobody has opened one of these in Excel. The file's shape,
contents and headers are verified; that Excel accepts it is not. That needs a
Windows machine with the Snowflake ODBC driver installed.
