# Semantic model tab — design

Date: 2026-08-20
Status: approved in conversation, ready for planning

## The problem

A report is bound to one semantic view, and everything a person can put on
a visual comes out of that view — its tables, the joins between them, and
the dimensions, metrics and facts each table carries. None of that is
visible anywhere in the product. The field list shows a flat set of names
with no indication of which table they come from, how those tables relate,
or why some field combinations are answerable and others are not.

That last point is not cosmetic. `app/semantic/joins.py` already refuses
combinations the model cannot join, and today the only way to discover the
shape it is reasoning over is to try a combination and read the refusal.

This is also the groundwork for custom measures: writing `PROFIT / REVENUE`
is guesswork until you can see that both are metrics of the same table.

## What already exists

`describe_semantic_view` (`app/semantic/discovery.py`) returns everything
the diagram needs, and the frontend already receives it as
`SemanticViewDetail`:

```ts
tables: { name: string }[]
relationships: { name, table, refTable }[]   // FK side -> PK side, directed
dimensions | metrics | facts: { table, name, dataType }[]
modelHierarchies?: Hierarchy[]
```

The describe is cached per session inside the connection cache entry, so
opening the tab costs no Snowflake round trip beyond the one the report
already made.

**This feature therefore adds no endpoint, no migration and no change to
the report document.** It is a new way of reading data the client is
already holding.

## Scope

In scope: a read-only diagram of one semantic view — tables as nodes,
declared relationships as directed edges, each table's fields listed and
grouped by kind, and a detail panel for a selected table.

Out of scope, deliberately: editing the model (that is DDL, which this app
never issues — ADR 0001), inferring undeclared relationships, and drawing
anything about a second view. A report is bound to exactly one view.

## Where it lives

The builder currently has one canvas area showing pages of visuals, plus
side panels (`PanelKind` = export | import | ask | connect) that overlay
it. A diagram needs the whole canvas, so the model is **a view switch, not
a panel**: a `Report | Model` control in the command bar swaps what the
canvas column renders. The field pane, filters and page bar stay put when
Model is showing, because they still describe the same view.

Choosing Model changes nothing about the report document — it is a way of
looking, not a piece of state worth saving.

## Layout

```
+-- Report | [Model] ------------------------------------------+
|                                                              |
|   +----------------+          +------------------+           |
|   |  ORDERS        |--------->|  CUSTOMERS       |           |
|   |  fact          |  cust_fk |  dimension       |           |
|   |  12 fields     |          |  8 fields        |           |
|   +----------------+          +------------------+           |
|          |                                                   |
|          | line_fk                                           |
|          v                                                   |
|   +----------------+                                         |
|   |  LINEITEM      |     [selected]  ORDERS                  |
|   |  6 fields      |     Metrics   TOTAL_REVENUE, ORDER_COUNT|
|   +----------------+     Dimensions ORDER_STATUS, ORDER_DATE |
|                          Facts     AMOUNT                    |
+--------------------------------------------------------------+
```

A node shows the table name, how many fields it has, and a badge for the
role it plays in the join graph. An edge is drawn from the foreign-key
side to the primary-key side, labelled with the relationship name, with an
arrowhead — direction is the whole point, since it is what decides which
combinations are answerable.

Selecting a table fills a detail list beside the diagram: its dimensions,
metrics and facts, each with its data type. Selecting an edge names the
two tables and the relationship.

## Layout algorithm

Relationships are directed and acyclic in every model seen so far, so
nodes are placed by **longest-path layering**: a table with no outgoing
relationship sits in the last layer, and each table sits one layer before
the furthest table it points at. Within a layer, order is by name so the
diagram is stable between renders — a node that moves when nothing changed
reads as the diagram being unreliable.

A cycle, if a model ever declares one, must not hang the layout: the
layering runs with a visited set and any table it cannot place goes in a
final "unplaced" layer rather than recursing forever.

Rendering is plain SVG. The project already depends on ECharts, but ECharts
graph layouts are force-directed and animate to a different arrangement
each time, which is the opposite of what a model diagram needs.

## Module boundaries

| File | Responsibility |
|---|---|
| `src/model/layout.ts` | `layoutModel(detail)` → nodes with (layer, x, y) and edges with endpoints. Pure, no React, no SVG. |
| `src/model/ModelDiagram.tsx` | The SVG: nodes, directed edges, selection. Presentation only. |
| `src/model/TableDetail.tsx` | The selected table's fields, grouped by kind. |
| `src/model/ModelTab.tsx` | Composes the three, owns which table is selected. |
| `src/reports/builder/BuilderCanvasColumn.tsx` | Renders `ModelTab` instead of pages when the mode is Model. |
| `src/reports/builder/BuilderHeader.tsx` | The `Report | Model` control. |
| `src/reports/builder/useBuilderInteraction.ts` | Holds the mode, beside the other ephemeral view state. |

Layout is separated from rendering because the placement rules are where
the logic and the edge cases live — layering, cycles, stable ordering —
and they are worth testing without mounting a component or parsing SVG.

## Error and empty states

A view with tables but no declared relationships draws the nodes
unconnected, with a line saying the model declares no joins — that is a
true and useful fact about the model, not an error.

A report not yet bound to a view shows the same hint the rest of the
builder shows, rather than an empty canvas.

A describe that fails is the existing query error path; the tab does not
fetch anything of its own.

## Testing

`layout.ts`: a two-table model places the FK side before the PK side;
a chain of three produces three layers; two tables pointing at one put
both in the same layer; nodes within a layer are alphabetical; a declared
cycle terminates and places every table exactly once; a model with no
relationships puts every table in one layer.

`ModelDiagram.tsx`: every table renders; an edge is drawn per
relationship; clicking a node selects it; the diagram is keyboard
reachable and each node names itself to assistive technology.

`ModelTab.tsx`: the selected table's fields appear grouped by kind; a
view with no relationships renders the nodes and the explanatory line;
switching the report's view resets the selection.

Builder integration: the control switches the canvas and back; choosing
Model leaves the report document untouched (asserted, since a view mode
that dirties a report would prompt to save on leaving).
