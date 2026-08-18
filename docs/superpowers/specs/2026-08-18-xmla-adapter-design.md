# XMLA adapter: Excel "Get Data → Analysis Services" over the existing API

**Date:** 2026-08-18. **Status:** building.

## What this is

An XMLA endpoint inside the existing FastAPI backend that lets Excel's
built-in Analysis Services client (the MSOLAP provider) treat each Snowflake
semantic view as a cube. Excel gets a real OLAP PivotTable: drag fields to
rows/columns, expand and collapse (drill), slicers, filters — and every
expansion issues a NEW query, so nothing is ever extracted to the file. This
is the shape that survives a billion rows, because the rows stay in Snowflake.

    Excel ──MSOLAP/XMLA──▶ POST /xmla ──▶ semantic query builder ──▶ SEMANTIC_VIEW(...)

## The mapping

| Analysis Services concept | Backed by |
|---|---|
| Catalog / cube | one semantic view |
| Dimension | one entity (logical table) |
| Attribute hierarchy | one dimension field — two levels, `(All)` + leaf |
| Measure | one metric |
| User hierarchy | model-declared hierarchies, when a view exposes them (none seen yet) |
| Relationship | the view's join graph — used for validity, not exposed as an object |

Attribute hierarchies are the load-bearing choice: they are how SSAS Tabular
itself models plain columns, and they are what makes every field individually
draggable, nestable (drill by stacking on an axis), sliceable and filterable
in Excel. Report-defined hierarchies are per-report and stay out of a
per-view catalog.

## Facts established against the real client (not the spec)

- The Office x64 ClickToRun MSOLAP registration (`MSOLAP.8`, "MSOLAP 17.0
  Client") is **visible only inside Office processes** — standalone ADODB
  cannot load it. All verification therefore drives Excel itself via COM.
- `PivotCaches().Create(xlExternal, connectionString)` fails up front;
  `Workbook.Connections.Add2(... xlCmdCube)` + `PivotCaches().Create(xlExternal,
  connectionObject)` reaches the network.
- First request on the wire: SOAP `Discover` with
  `RequestType=DISCOVER_PROPERTIES`, `SOAPAction:
  urn:schemas-microsoft-com:xml-analysis:Discover`, and an engine `Version`
  header. The provider **hangs** on a malformed response rather than erroring —
  so every slice below is verified by watching the client advance, not by
  asserting our XML looks right to us.

## Authentication

HTTP Basic on /xmla, mapped to the same machinery as password dev-login: the
credentials open the caller's own Snowflake connection, and every Discover
and Execute runs on it. No service account, no stored result — the same rule
as the rest of the product. Session reuse is keyed on the XMLA `Session`
SOAP header backed by the existing per-session connection cache. TLS is the
deployment's job, exactly as it already is for dev-login.

## Slices (each verified in Excel before the next starts)

1. **Handshake** — SOAP envelope parse/build, DISCOVER_PROPERTIES,
   DISCOVER_DATASOURCES, DBSCHEMA_CATALOGS, BeginSession/EndSession.
2. **Catalog** — MDSCHEMA_CUBES, _DIMENSIONS, _HIERARCHIES, _LEVELS,
   _MEASURES, _MEASUREGROUPS (+ _MEMBERS for filter dropdowns), all built
   from the same DESCRIBE the rest of the product uses.
3. **Execute** — the MDX subset Excel's pivot engine actually generates
   (captured from the wire, not imagined): member sets, CrossJoin,
   Hierarchize, DrilldownLevel/Member, NON EMPTY, WHERE tuples and subselect
   filters — translated to a SemanticQueryRequest and answered as an
   `mddataset`.
4. **End to end** — COM-driven Excel: pivot built, measure + hierarchy
   placed, nested drill, slicer, filter; numbers cross-checked against the
   same query through /api/query/semantic.

## What this does NOT do

No writeback, no calculated members from the client, no KPIs, no
drillthrough-to-rows (Excel's "Show Details" on OLAP needs DRILLTHROUGH MDX;
may come later), no DAX. Unknown Discover types answer an empty rowset
rather than a fault, because the provider treats unknown-type faults as
fatal but tolerates empty.
