# 0002 — Excel connects through a first-party XMLA endpoint

Status: Accepted

## Context

Analysts live in Excel and expect a native pivot: drag fields, drill,
collapse, filter — against live data, not a file export. The routes
considered: a custom ODBC/OLE DB driver (an installer on every desktop,
a support burden forever), Power Query web feeds (no pivot drill
model), or speaking the protocol stock Excel already speaks — XMLA over
HTTP, as an Analysis Services data source.

## Decision

The backend implements the XMLA subset MSOLAP actually uses (Discover
rowsets, BeginSession, a working MDX subset), in `app/xmla/`. No client
installs; Excel's built-in "From Analysis Services" connects directly.

## Consequences

- Zero footprint on user desktops; slicing and drilling are native
  Excel gestures, and visual totals are recomputed by Snowflake.
- We own a protocol with no error messages: MSOLAP hangs or throws
  generic HRESULTs. The wire-capture workflow in CONTRIBUTING is the
  cost of this decision, paid once and written down.
- Mondrian's responses (Excel-accepted for years) are our ground truth
  for rowset layouts; captures become test fixtures verbatim.
- The MDX evaluator only grows what Excel actually sends — it is not,
  and must not become, a general MDX engine.
