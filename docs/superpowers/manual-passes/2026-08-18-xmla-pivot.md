# Manual pass: Excel PivotTable over the XMLA adapter (live)

Date: 2026-08-18. Driver: Excel (Microsoft 365, MSOLAP 17) automated over
COM against the real backend and the real Snowflake TPC-H semantic view
`SEMANTIC_DEMO.TPCH.TPCH_SALES_ANALYTICS`, authenticated with a connect
token minted by `POST /api/connect/token`. Every step below was observed,
not inferred; wire traces live in the session scratchpad.

## What was verified

| Step | Result |
| --- | --- |
| `PivotCaches().Create` against `http://…/xmla` | Connects; 22 cube fields (16 attribute hierarchies + 6 measures) |
| Drag measure `TOTAL_ORDER_VALUE` to Values | Grand total 226,829,306,447.46 — matches Snowflake |
| Drag `ORDER_STATUS` to Rows | F / O / P rows + Grand Total, values sum correctly |
| Drag second row field `ORDER_PRIORITY` (drilldown) | Nested breakdown, per-combination values from GROUP BY both fields |
| Add `MARKET_SEGMENT` as page filter | Filter chip appears, dropdown backed by MDSCHEMA_MEMBERS |
| Select `BUILDING` in the filter (slice) | All numbers move: grand total 226.8B → 45.9B |

## The protocol rules that made it work

Each was found on the wire (16+ Excel drives) or via ADOMD.NET stack
traces, then verified by re-driving Excel:

1. **DISCOVER_SCHEMA_ROWSETS advertises full canonical restriction lists,
   in canonical ORDER.** MSOLAP translates OLE DB restriction ordinals to
   XMLA names using the order the server advertises — a swapped pair
   mislabels every later restriction (observed: `PROPERTY_TYPE=2` arriving
   named `PROPERTY_NAME`).
2. **A statement-less Execute answers the empty-namespace root**
   (`urn:schemas-microsoft-com:xml-analysis:empty`), not an empty
   mddataset.
3. **MDSCHEMA_PROPERTIES answers the cell-property list** for
   `PROPERTY_TYPE=2`; member-property queries answer level-scoped rows
   only where custom properties exist (for us: none).
4. **The metadata rowsets mirror Mondrian's Excel-accepted layouts**
   byte-for-byte in column order, required-vs-optional flags, and the
   `uuid` simpleType — extracted from Mondrian's recorded Excel fixtures.
5. **`[Measures]` exists as a hierarchy and `MeasuresLevel` level** in the
   discover rowsets; without them Excel refuses to put any measure on a
   pivot.
6. **mddataset axis rules:** hierarchy references use unique names; every
   member property (e.g. `PARENT_UNIQUE_NAME`) is declared in the axis
   `HierarchyInfo` before any `Member` carries it; an empty slicer is an
   empty `<Tuples/>`, never an empty `<Tuple/>`.
7. **SOAP fault `ErrorCode` is numeric** — clients parse it with a number
   parser.
8. **MDSCHEMA_MEMBERS is live**: TREE_OP SELF/CHILDREN/PARENT, leaf
   members from a `SELECT DISTINCT` on the view (capped 1000), and
   bracket-segment parsing that understands key access
   (`].&[BUILDING]`).

## Auth path

No Snowflake credentials touch Excel. The app UI mints a connect token
(sha256 stored, shown once, ≤24h, dies with the app session); Excel sends
it as Basic auth / `Password=`. The adapter resolves it to the signed-in
app session and runs every query on that session's cached Snowflake
connection — the same one the browser UI uses.

## Not yet covered

- Column-axis fields (`ON ROWS` + fields `ON COLUMNS` simultaneously
  beyond measures) — engine supports two axes; not live-driven.
- Multi-select page filters (subselect filters are parsed and applied;
  not live-driven).
- Excel UI click-through by a human (all drives were COM-automated; the
  UI dialog flow is the same engine but has not been hand-walked).
- Refresh of a saved workbook across sessions (token must still be valid).
