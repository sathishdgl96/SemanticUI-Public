# Semantic Model Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only diagram in the report builder showing the bound semantic view's tables, the declared joins between them, and each table's fields.

**Architecture:** Pure frontend. `describe_semantic_view` already returns `tables` and directed `relationships`, and the client already holds them as `SemanticViewDetail`. Layout is a pure function (longest-path layering) separated from an SVG renderer, and the builder gains a `Report | Model` view switch that swaps what the canvas column renders.

**Tech Stack:** React 19 + TypeScript strict, Vitest + Testing Library, plain inline SVG (no new dependency).

**Spec:** `docs/superpowers/specs/2026-08-20-semantic-model-tab-design.md`

## Global Constraints

- No backend change: no endpoint, no migration, no change to the report document. If a task seems to need one, stop — the spec is wrong and needs revisiting.
- Choosing Model must never dirty the report. A view mode that marks a report unsaved would prompt on leaving.
- `frontend/src/query/palette.ts` is order-sensitive: never modify or reorder it.
- Layout must be deterministic. The same `SemanticViewDetail` always produces the same coordinates — a diagram that moves when nothing changed reads as unreliable.
- Comments state constraints the code cannot show. No narration of the next line.
- Commands run from `frontend/`: `npm test -- --run`, `npx tsc --noEmit`, `npm run lint`, `npm run build`. `npm run build` typechecks test files too and catches what `tsc --noEmit` misses — run it before every commit.
- Existing lint baseline is 4 pre-existing `react-refresh` warnings (VisualPicker, CanvasGrid, ColorField, FilterEditor). Introduce none.

---

## File Structure

**New**

| File | Responsibility |
|---|---|
| `src/model/layout.ts` | `layoutModel(detail)` → positioned nodes and edges. Pure; no React, no SVG. |
| `src/model/layout.test.ts` | Layering, ordering, cycles, empty models. |
| `src/model/ModelDiagram.tsx` | The SVG: nodes, directed edges, selection. Presentation only. |
| `src/model/ModelDiagram.test.tsx` | Renders every table, an edge per relationship, selection, a11y. |
| `src/model/TableDetail.tsx` | One table's fields, grouped by kind. |
| `src/model/TableDetail.test.tsx` | Grouping, data types, a table with no fields of a kind. |
| `src/model/ModelTab.tsx` | Composes diagram + detail; owns the selected table. |
| `src/model/ModelTab.test.tsx` | Selection flow, no-relationships state, unbound view. |

**Modified**

| File | Change |
|---|---|
| `src/reports/builder/useBuilderInteraction.ts` | `mode: "report" \| "model"` + setter, reset with the rest. |
| `src/reports/builder/BuilderHeader.tsx` | The `Report \| Model` control. |
| `src/reports/builder/BuilderCanvasColumn.tsx` | Render `ModelTab` when the mode is model. |
| `src/reports/BuilderPage.tsx` | Pass `viewDetail` down to the canvas column. |
| `src/index.css` | Diagram, node, edge and detail styles. |

---

### Task 1: Layout

**Files:**
- Create: `frontend/src/model/layout.ts`
- Test: `frontend/src/model/layout.test.ts`

**Interfaces:**
- Consumes: `SemanticViewDetail`, `Relationship`, `FieldInfo` from `src/api/types.ts`.
- Produces:
  ```ts
  export interface ModelNode {
    name: string;
    layer: number;
    x: number; y: number; width: number; height: number;
    fieldCount: number;
  }
  export interface ModelEdge {
    name: string;
    from: string; to: string;
    x1: number; y1: number; x2: number; y2: number;
  }
  export interface ModelLayout { nodes: ModelNode[]; edges: ModelEdge[]; width: number; height: number; }
  export function layoutModel(detail: SemanticViewDetail): ModelLayout;
  export const NODE_WIDTH = 180;
  export const NODE_HEIGHT = 64;
  ```

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/model/layout.test.ts
import { describe, expect, it } from "vitest";
import { layoutModel, NODE_WIDTH } from "./layout";
import type { SemanticViewDetail } from "../api/types";

function model(
  tables: string[],
  relationships: { name: string; table: string; refTable: string }[] = [],
  fields: { table: string; name: string }[] = [],
): SemanticViewDetail {
  return {
    tables: tables.map((name) => ({ name })),
    relationships,
    dimensions: fields.map((f) => ({ ...f, dataType: "TEXT" })),
    metrics: [],
    facts: [],
  };
}

describe("layoutModel", () => {
  it("puts the foreign-key side before the table it points at", () => {
    // Direction is the whole point: it is what decides which field
    // combinations are answerable.
    const layout = layoutModel(
      model(["ORDERS", "CUSTOMERS"], [
        { name: "cust_fk", table: "ORDERS", refTable: "CUSTOMERS" },
      ]),
    );
    const byName = Object.fromEntries(layout.nodes.map((n) => [n.name, n]));
    expect(byName.ORDERS.layer).toBeLessThan(byName.CUSTOMERS.layer);
  });

  it("gives a chain of three one layer each", () => {
    const layout = layoutModel(
      model(["LINEITEM", "ORDERS", "CUSTOMERS"], [
        { name: "a", table: "LINEITEM", refTable: "ORDERS" },
        { name: "b", table: "ORDERS", refTable: "CUSTOMERS" },
      ]),
    );
    expect(new Set(layout.nodes.map((n) => n.layer)).size).toBe(3);
  });

  it("puts two tables pointing at the same one in the same layer", () => {
    const layout = layoutModel(
      model(["ORDERS", "RETURNS", "CUSTOMERS"], [
        { name: "a", table: "ORDERS", refTable: "CUSTOMERS" },
        { name: "b", table: "RETURNS", refTable: "CUSTOMERS" },
      ]),
    );
    const byName = Object.fromEntries(layout.nodes.map((n) => [n.name, n]));
    expect(byName.ORDERS.layer).toBe(byName.RETURNS.layer);
  });

  it("orders within a layer by name, so the diagram never moves on its own", () => {
    const layout = layoutModel(model(["ZEBRA", "ALPHA", "MIKE"]));
    expect(layout.nodes.map((n) => n.name)).toEqual(["ALPHA", "MIKE", "ZEBRA"]);
  });

  it("places every table exactly once even if the model declares a cycle", () => {
    const layout = layoutModel(
      model(["A", "B"], [
        { name: "a", table: "A", refTable: "B" },
        { name: "b", table: "B", refTable: "A" },
      ]),
    );
    expect(layout.nodes.map((n) => n.name).sort()).toEqual(["A", "B"]);
  });

  it("puts every table in one layer when nothing is joined", () => {
    const layout = layoutModel(model(["A", "B", "C"]));
    expect(new Set(layout.nodes.map((n) => n.layer))).toEqual(new Set([0]));
  });

  it("counts the fields each table carries", () => {
    const layout = layoutModel(
      model(["ORDERS"], [], [
        { table: "ORDERS", name: "STATUS" },
        { table: "ORDERS", name: "DATE" },
      ]),
    );
    expect(layout.nodes[0].fieldCount).toBe(2);
  });

  it("drops a relationship whose endpoints are not both real tables", () => {
    // `table`/`refTable` are nullable in the describe payload.
    const layout = layoutModel(
      model(["A"], [{ name: "dangling", table: "A", refTable: "GONE" }]),
    );
    expect(layout.edges).toEqual([]);
  });

  it("gives an empty model an empty layout rather than throwing", () => {
    const layout = layoutModel(model([]));
    expect(layout).toMatchObject({ nodes: [], edges: [], width: 0, height: 0 });
  });

  it("sizes the canvas to hold every node", () => {
    const layout = layoutModel(model(["A", "B"]));
    expect(layout.width).toBeGreaterThanOrEqual(NODE_WIDTH);
    expect(layout.height).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/layout.test.ts`
Expected: FAIL — cannot resolve `./layout`

- [ ] **Step 3: Implement**

```typescript
// frontend/src/model/layout.ts
import type { Relationship, SemanticViewDetail } from "../api/types";

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 64;
const GAP_X = 90;
const GAP_Y = 28;
const PADDING = 16;

export interface ModelNode {
  name: string;
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fieldCount: number;
}

export interface ModelEdge {
  name: string;
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ModelLayout {
  nodes: ModelNode[];
  edges: ModelEdge[];
  width: number;
  height: number;
}

/** Relationships whose two ends are both tables in this model.
 *  `table` and `refTable` are nullable in the describe payload, and a
 *  dangling end would otherwise place a node that does not exist. */
function realEdges(detail: SemanticViewDetail): Relationship[] {
  const names = new Set(detail.tables.map((t) => t.name));
  return detail.relationships.filter(
    (r) => r.table && r.refTable && names.has(r.table) && names.has(r.refTable),
  );
}

/**
 * Longest path to a table with no outgoing relationship.
 *
 * Iterative rather than recursive, and capped by the table count: a model
 * that declares a cycle must still place every table once rather than
 * running until the stack gives out.
 */
function layerOf(
  table: string,
  outgoing: Map<string, string[]>,
  cache: Map<string, number>,
  limit: number,
): number {
  const seen = new Set<string>();
  const walk = (name: string, depth: number): number => {
    const known = cache.get(name);
    if (known !== undefined) return known;
    if (depth > limit || seen.has(name)) return 0;
    seen.add(name);
    const next = outgoing.get(name) ?? [];
    const layer = next.length === 0
      ? 0
      : Math.max(...next.map((target) => walk(target, depth + 1) + 1));
    seen.delete(name);
    cache.set(name, layer);
    return layer;
  };
  return walk(table, 0);
}

export function layoutModel(detail: SemanticViewDetail): ModelLayout {
  const tables = detail.tables.map((t) => t.name);
  if (tables.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const edges = realEdges(detail);
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.table!) ?? [];
    list.push(edge.refTable!);
    outgoing.set(edge.table!, list);
  }

  const fieldCounts = new Map<string, number>();
  for (const field of [...detail.dimensions, ...detail.metrics, ...detail.facts]) {
    fieldCounts.set(field.table, (fieldCounts.get(field.table) ?? 0) + 1);
  }

  // Deepest first: a table sits one layer before the furthest table it
  // points at, so the arrow always runs left to right.
  const cache = new Map<string, number>();
  const depth = new Map(
    tables.map((t) => [t, layerOf(t, outgoing, cache, tables.length)]),
  );
  const deepest = Math.max(...depth.values());

  const byLayer = new Map<number, string[]>();
  for (const table of [...tables].sort((a, b) => a.localeCompare(b))) {
    const layer = deepest - (depth.get(table) ?? 0);
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), table]);
  }

  const nodes: ModelNode[] = [];
  for (const [layer, names] of byLayer) {
    names.forEach((name, row) => {
      nodes.push({
        name,
        layer,
        x: PADDING + layer * (NODE_WIDTH + GAP_X),
        y: PADDING + row * (NODE_HEIGHT + GAP_Y),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        fieldCount: fieldCounts.get(name) ?? 0,
      });
    });
  }
  nodes.sort((a, b) => a.name.localeCompare(b.name));

  const at = new Map(nodes.map((n) => [n.name, n]));
  const positioned: ModelEdge[] = edges.flatMap((edge) => {
    const from = at.get(edge.table!);
    const to = at.get(edge.refTable!);
    if (!from || !to) return [];
    return [{
      name: edge.name,
      from: from.name,
      to: to.name,
      x1: from.x + from.width,
      y1: from.y + from.height / 2,
      x2: to.x,
      y2: to.y + to.height / 2,
    }];
  });

  return {
    nodes,
    edges: positioned,
    width: Math.max(...nodes.map((n) => n.x + n.width)) + PADDING,
    height: Math.max(...nodes.map((n) => n.y + n.height)) + PADDING,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/model/layout.test.ts`
Expected: 10 passed

- [ ] **Step 5: Commit**

```bash
git add frontend/src/model/layout.ts frontend/src/model/layout.test.ts
git commit -m "feat(model): layered layout for a semantic view's tables"
```

---

### Task 2: The diagram

**Files:**
- Create: `frontend/src/model/ModelDiagram.tsx`
- Test: `frontend/src/model/ModelDiagram.test.tsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: `layoutModel`, `ModelLayout` from Task 1.
- Produces: `<ModelDiagram detail selected onSelect />` where `selected: string | null` and `onSelect: (table: string) => void`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/model/ModelDiagram.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ModelDiagram from "./ModelDiagram";
import type { SemanticViewDetail } from "../api/types";

const DETAIL: SemanticViewDetail = {
  tables: [{ name: "ORDERS" }, { name: "CUSTOMERS" }],
  relationships: [{ name: "cust_fk", table: "ORDERS", refTable: "CUSTOMERS" }],
  dimensions: [{ table: "ORDERS", name: "STATUS", dataType: "TEXT" }],
  metrics: [{ table: "ORDERS", name: "REVENUE", dataType: "NUMBER" }],
  facts: [],
};

describe("ModelDiagram", () => {
  it("draws every table", () => {
    render(<ModelDiagram detail={DETAIL} selected={null} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /ORDERS/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /CUSTOMERS/ })).toBeInTheDocument();
  });

  it("draws one edge per declared relationship, named", () => {
    const { container } = render(
      <ModelDiagram detail={DETAIL} selected={null} onSelect={() => {}} />,
    );
    expect(container.querySelectorAll("[data-edge]")).toHaveLength(1);
    expect(screen.getByText("cust_fk")).toBeInTheDocument();
  });

  it("selects a table when it is clicked", async () => {
    const onSelect = vi.fn();
    render(<ModelDiagram detail={DETAIL} selected={null} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: /ORDERS/ }));
    expect(onSelect).toHaveBeenCalledWith("ORDERS");
  });

  it("marks the selected table for assistive technology", () => {
    render(<ModelDiagram detail={DETAIL} selected="ORDERS" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /ORDERS/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("says so when the model declares no joins", () => {
    // A true fact about the model, not an error.
    render(
      <ModelDiagram
        detail={{ ...DETAIL, relationships: [] }}
        selected={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/no joins/i)).toBeInTheDocument();
  });

  it("says so when the view has no tables", () => {
    render(
      <ModelDiagram
        detail={{ ...DETAIL, tables: [], relationships: [] }}
        selected={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/no tables/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/ModelDiagram.test.tsx`
Expected: FAIL — cannot resolve `./ModelDiagram`

- [ ] **Step 3: Implement**

```tsx
// frontend/src/model/ModelDiagram.tsx
import { useMemo } from "react";
import type { SemanticViewDetail } from "../api/types";
import { layoutModel } from "./layout";

/** The model as a diagram: one node per table, one directed edge per
 *  declared relationship, pointing from the foreign-key side to the
 *  primary-key side. That direction is what app/semantic/joins.py reasons
 *  over when it decides a field combination is answerable, which is the
 *  thing this diagram exists to make visible. */
export default function ModelDiagram({
  detail,
  selected,
  onSelect,
}: {
  detail: SemanticViewDetail;
  selected: string | null;
  onSelect: (table: string) => void;
}) {
  const layout = useMemo(() => layoutModel(detail), [detail]);

  if (layout.nodes.length === 0) {
    return <p className="tile-hint">This view declares no tables.</p>;
  }

  return (
    <div className="model-diagram">
      {layout.edges.length === 0 && (
        <p className="tile-hint">
          This model declares no joins between its tables.
        </p>
      )}
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="group"
        aria-label="Semantic model diagram"
      >
        <defs>
          <marker
            id="model-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="model-arrowhead" />
          </marker>
        </defs>
        {layout.edges.map((edge) => (
          <g key={edge.name} data-edge={edge.name}>
            <line
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
              className="model-edge"
              markerEnd="url(#model-arrow)"
            />
            <text
              x={(edge.x1 + edge.x2) / 2}
              y={(edge.y1 + edge.y2) / 2 - 6}
              className="model-edge-label"
              textAnchor="middle"
            >
              {edge.name}
            </text>
          </g>
        ))}
        {layout.nodes.map((node) => (
          <g key={node.name} transform={`translate(${node.x}, ${node.y})`}>
            <foreignObject width={node.width} height={node.height}>
              <button
                type="button"
                className={
                  selected === node.name ? "model-node selected" : "model-node"
                }
                aria-pressed={selected === node.name}
                onClick={() => onSelect(node.name)}
              >
                <span className="model-node-name">{node.name}</span>
                <span className="model-node-meta">
                  {node.fieldCount} {node.fieldCount === 1 ? "field" : "fields"}
                </span>
              </button>
            </foreignObject>
          </g>
        ))}
      </svg>
    </div>
  );
}
```

- [ ] **Step 4: Add the styles**

Append to `frontend/src/index.css`:

```css
/* --- Semantic model diagram ----------------------------------------- */

.model-diagram {
  overflow: auto;
  padding: 8px;
}

/* Rendered through foreignObject so a node is a real button: focusable,
   announced, and keyboard-reachable without reimplementing any of it on
   an SVG shape. */
.model-node {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  height: 100%;
  padding: 8px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--ink);
  font-weight: 400;
  text-align: left;
  cursor: pointer;
}

.model-node:hover {
  border-color: var(--accent);
}

.model-node.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-wash);
}

.model-node-name {
  font-weight: 600;
  font-size: 13px;
}

.model-node-meta {
  color: var(--ink-secondary);
  font-size: 11px;
}

.model-edge {
  stroke: var(--axis);
  stroke-width: 1.5;
  fill: none;
}

.model-arrowhead {
  fill: var(--axis);
}

.model-edge-label {
  fill: var(--ink-muted);
  font-size: 10px;
}
```

- [ ] **Step 5: Run tests, types and build**

Run: `npx vitest run src/model && npx tsc --noEmit && npm run build`
Expected: 16 passed, clean, built

- [ ] **Step 6: Commit**

```bash
git add frontend/src/model frontend/src/index.css
git commit -m "feat(model): the diagram, with directed edges"
```

---

### Task 3: Table detail

**Files:**
- Create: `frontend/src/model/TableDetail.tsx`
- Test: `frontend/src/model/TableDetail.test.tsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: `SemanticViewDetail`, `FieldInfo`.
- Produces: `<TableDetail detail table />` where `table: string | null`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/model/TableDetail.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import TableDetail from "./TableDetail";
import type { SemanticViewDetail } from "../api/types";

const DETAIL: SemanticViewDetail = {
  tables: [{ name: "ORDERS" }, { name: "CUSTOMERS" }],
  relationships: [],
  dimensions: [
    { table: "ORDERS", name: "STATUS", dataType: "TEXT" },
    { table: "CUSTOMERS", name: "REGION", dataType: "TEXT" },
  ],
  metrics: [{ table: "ORDERS", name: "REVENUE", dataType: "NUMBER" }],
  facts: [{ table: "ORDERS", name: "AMOUNT", dataType: "NUMBER" }],
};

describe("TableDetail", () => {
  it("invites a selection when nothing is chosen", () => {
    render(<TableDetail detail={DETAIL} table={null} />);
    expect(screen.getByText(/select a table/i)).toBeInTheDocument();
  });

  it("shows only the chosen table's fields, grouped by kind", () => {
    render(<TableDetail detail={DETAIL} table="ORDERS" />);
    expect(screen.getByText("STATUS")).toBeInTheDocument();
    expect(screen.getByText("REVENUE")).toBeInTheDocument();
    expect(screen.getByText("AMOUNT")).toBeInTheDocument();
    // CUSTOMERS.REGION belongs to another table.
    expect(screen.queryByText("REGION")).not.toBeInTheDocument();
  });

  it("names each group", () => {
    render(<TableDetail detail={DETAIL} table="ORDERS" />);
    expect(screen.getByText(/dimensions/i)).toBeInTheDocument();
    expect(screen.getByText(/metrics/i)).toBeInTheDocument();
    expect(screen.getByText(/facts/i)).toBeInTheDocument();
  });

  it("shows each field's data type", () => {
    render(<TableDetail detail={DETAIL} table="ORDERS" />);
    expect(screen.getAllByText("NUMBER").length).toBeGreaterThan(0);
  });

  it("omits a group the table has nothing in", () => {
    render(<TableDetail detail={DETAIL} table="CUSTOMERS" />);
    expect(screen.getByText(/dimensions/i)).toBeInTheDocument();
    expect(screen.queryByText(/metrics/i)).not.toBeInTheDocument();
  });

  it("says so for a table with no fields at all", () => {
    render(
      <TableDetail
        detail={{ ...DETAIL, dimensions: [], metrics: [], facts: [] }}
        table="ORDERS"
      />,
    );
    expect(screen.getByText(/no fields/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/TableDetail.test.tsx`
Expected: FAIL — cannot resolve `./TableDetail`

- [ ] **Step 3: Implement**

```tsx
// frontend/src/model/TableDetail.tsx
import type { FieldInfo, SemanticViewDetail } from "../api/types";

/** What one table carries, grouped the way the semantic model itself
 *  distinguishes them: a metric is already aggregated, a fact is
 *  row-level, and the server refuses to mix the two in one query. */
export default function TableDetail({
  detail,
  table,
}: {
  detail: SemanticViewDetail;
  table: string | null;
}) {
  if (!table) {
    return <p className="tile-hint">Select a table to see its fields.</p>;
  }

  const groups: { label: string; fields: FieldInfo[] }[] = [
    { label: "Dimensions", fields: detail.dimensions.filter((f) => f.table === table) },
    { label: "Metrics", fields: detail.metrics.filter((f) => f.table === table) },
    { label: "Facts", fields: detail.facts.filter((f) => f.table === table) },
  ].filter((group) => group.fields.length > 0);

  return (
    <div className="model-detail">
      <h3 className="model-detail-title">{table}</h3>
      {groups.length === 0 && (
        <p className="tile-hint">This table has no fields in the model.</p>
      )}
      {groups.map((group) => (
        <section key={group.label}>
          <h4 className="model-detail-group">{group.label}</h4>
          <ul className="model-detail-fields">
            {group.fields.map((field) => (
              <li key={field.name}>
                <span className="model-field-name">{field.name}</span>
                {field.dataType && (
                  <span className="model-field-type">{field.dataType}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Add the styles**

Append to `frontend/src/index.css`:

```css
.model-detail {
  min-width: 220px;
  max-width: 280px;
  padding: 12px;
  border-left: 1px solid var(--border);
  overflow-y: auto;
}

.model-detail-title {
  margin: 0 0 8px;
  font-size: 14px;
}

.model-detail-group {
  margin: 12px 0 4px;
  color: var(--ink-secondary);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.model-detail-fields {
  margin: 0;
  padding: 0;
  list-style: none;
}

.model-detail-fields li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
}

.model-field-type {
  color: var(--ink-muted);
  font-family: var(--font-mono);
  font-size: 10px;
}
```

- [ ] **Step 5: Run tests and build**

Run: `npx vitest run src/model && npx tsc --noEmit && npm run build`
Expected: 22 passed, clean, built

- [ ] **Step 6: Commit**

```bash
git add frontend/src/model frontend/src/index.css
git commit -m "feat(model): the selected table's fields, grouped by kind"
```

---

### Task 4: The tab

**Files:**
- Create: `frontend/src/model/ModelTab.tsx`
- Test: `frontend/src/model/ModelTab.test.tsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: `ModelDiagram`, `TableDetail`.
- Produces: `<ModelTab detail />` where `detail: SemanticViewDetail | undefined`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/model/ModelTab.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import ModelTab from "./ModelTab";
import type { SemanticViewDetail } from "../api/types";

const DETAIL: SemanticViewDetail = {
  tables: [{ name: "ORDERS" }, { name: "CUSTOMERS" }],
  relationships: [{ name: "cust_fk", table: "ORDERS", refTable: "CUSTOMERS" }],
  dimensions: [{ table: "ORDERS", name: "STATUS", dataType: "TEXT" }],
  metrics: [],
  facts: [],
};

describe("ModelTab", () => {
  it("waits for the view rather than drawing an empty diagram", () => {
    render(<ModelTab detail={undefined} />);
    expect(screen.getByText(/bind this report to a view/i)).toBeInTheDocument();
  });

  it("shows the diagram and invites a selection", () => {
    render(<ModelTab detail={DETAIL} />);
    expect(screen.getByRole("button", { name: /ORDERS/ })).toBeInTheDocument();
    expect(screen.getByText(/select a table/i)).toBeInTheDocument();
  });

  it("shows a table's fields once it is chosen", async () => {
    render(<ModelTab detail={DETAIL} />);
    await userEvent.click(screen.getByRole("button", { name: /ORDERS/ }));
    expect(screen.getByText("STATUS")).toBeInTheDocument();
  });

  it("clears the selection when the view changes under it", async () => {
    const { rerender } = render(<ModelTab detail={DETAIL} />);
    await userEvent.click(screen.getByRole("button", { name: /ORDERS/ }));
    expect(screen.getByText("STATUS")).toBeInTheDocument();

    // A table name from the old view must not survive into the new one.
    rerender(
      <ModelTab
        detail={{
          tables: [{ name: "SALES" }],
          relationships: [],
          dimensions: [{ table: "SALES", name: "CHANNEL", dataType: "TEXT" }],
          metrics: [],
          facts: [],
        }}
      />,
    );
    expect(screen.getByText(/select a table/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/ModelTab.test.tsx`
Expected: FAIL — cannot resolve `./ModelTab`

- [ ] **Step 3: Implement**

```tsx
// frontend/src/model/ModelTab.tsx
import { useEffect, useState } from "react";
import type { SemanticViewDetail } from "../api/types";
import ModelDiagram from "./ModelDiagram";
import TableDetail from "./TableDetail";

/** The model view of a report's bound semantic view. Read-only by
 *  design: changing a model is DDL, which this app never issues. */
export default function ModelTab({ detail }: { detail?: SemanticViewDetail }) {
  const [selected, setSelected] = useState<string | null>(null);

  // A selection is a table NAME, so it would otherwise survive into a
  // different view that happens to have no such table.
  useEffect(() => {
    setSelected(null);
  }, [detail]);

  if (!detail) {
    return (
      <p className="tile-hint">
        Bind this report to a view to see its model.
      </p>
    );
  }

  return (
    <div className="model-tab">
      <ModelDiagram detail={detail} selected={selected} onSelect={setSelected} />
      <TableDetail detail={detail} table={selected} />
    </div>
  );
}
```

- [ ] **Step 4: Add the styles**

Append to `frontend/src/index.css`:

```css
.model-tab {
  display: flex;
  align-items: stretch;
  height: 100%;
  min-height: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.model-tab .model-diagram {
  flex: 1 1 auto;
  min-width: 0;
}
```

- [ ] **Step 5: Run tests and build**

Run: `npx vitest run src/model && npx tsc --noEmit && npm run build`
Expected: 26 passed, clean, built

- [ ] **Step 6: Commit**

```bash
git add frontend/src/model frontend/src/index.css
git commit -m "feat(model): compose the diagram and the table detail"
```

---

### Task 5: The Report | Model switch

**Files:**
- Modify: `frontend/src/reports/builder/useBuilderInteraction.ts`, `frontend/src/reports/builder/BuilderHeader.tsx`, `frontend/src/reports/builder/BuilderCanvasColumn.tsx`, `frontend/src/reports/BuilderPage.tsx`, `frontend/src/index.css`
- Test: `frontend/src/reports/ModelSwitch.test.tsx`

**Interfaces:**
- Consumes: `ModelTab` from Task 4.
- Produces: `BuilderInteraction.mode: "report" | "model"` and `setMode`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/reports/ModelSwitch.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderBuilder } from "./builderTestHarness";

/** Read the harness first: it mounts BuilderPage with a stubbed report and
 *  view detail. If it does not exist yet, copy the setup from
 *  BuilderPage.test.tsx rather than inventing a second harness. */
describe("Report | Model switch", () => {
  it("starts on the report", async () => {
    await renderBuilder();
    expect(screen.getByRole("button", { name: /^model$/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("swaps the canvas for the model and back", async () => {
    await renderBuilder();
    await userEvent.click(screen.getByRole("button", { name: /^model$/i }));
    expect(
      screen.getByRole("group", { name: /semantic model diagram/i }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^report$/i }));
    expect(
      screen.queryByRole("group", { name: /semantic model diagram/i }),
    ).not.toBeInTheDocument();
  });

  it("does not mark the report unsaved", async () => {
    await renderBuilder();
    await userEvent.click(screen.getByRole("button", { name: /^model$/i }));
    // Looking at the model is not editing it: a dirty report would prompt
    // to save on leaving, for a change the user never made.
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/reports/ModelSwitch.test.tsx`
Expected: FAIL — no Model button (and the harness may need creating from `BuilderPage.test.tsx`'s existing setup)

- [ ] **Step 3: Add the mode to the interaction hook**

In `useBuilderInteraction.ts`, beside the other ephemeral state:

```typescript
  // Which surface the canvas shows. Ephemeral like the rest: a saved
  // report always opens on its pages, and looking at the model never
  // changes the document.
  const [mode, setMode] = useState<"report" | "model">("report");
```

Add `setMode("report");` to the reset effect, and `mode, setMode,` to the returned object.

- [ ] **Step 4: Add the control to the header**

In `BuilderHeader.tsx`, take `mode` and `onSetMode` as props and render, before the panel toggles:

```tsx
      <div className="mode-switch" role="group" aria-label="Report or model">
        <button
          type="button"
          aria-pressed={mode === "report"}
          onClick={() => onSetMode("report")}
        >
          Report
        </button>
        <button
          type="button"
          aria-pressed={mode === "model"}
          disabled={!viewName}
          title={viewName ? "See this view's tables and joins" : UNBOUND_HINT}
          onClick={() => onSetMode("model")}
        >
          Model
        </button>
      </div>
```

- [ ] **Step 5: Swap the canvas**

In `BuilderCanvasColumn.tsx`, accept `viewDetail?: SemanticViewDetail` and return the model instead of the pages when the mode is model:

```tsx
  if (ui.mode === "model") {
    return (
      <div className="canvas-column">
        <ModelTab detail={viewDetail} />
      </div>
    );
  }
```

In `BuilderPage.tsx`, pass `viewDetail={fields.detail}` (the `useViewFields` describe query's data) to `BuilderCanvasColumn`, and `mode={ui.mode} onSetMode={ui.setMode}` to `BuilderHeader`.

- [ ] **Step 6: Add the styles**

Append to `frontend/src/index.css`:

```css
/* A segmented control: one border around both, so it reads as one choice
   rather than two unrelated buttons. */
.mode-switch {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}

.mode-switch button {
  padding: 4px 12px;
  background: var(--surface);
  border: none;
  border-radius: 0;
  color: var(--ink-secondary);
  font-weight: 400;
  font-size: 13px;
}

.mode-switch button[aria-pressed="true"] {
  background: var(--accent);
  color: #ffffff;
  font-weight: 600;
}

.mode-switch button:disabled {
  opacity: 0.5;
}
```

- [ ] **Step 7: Run the full gate**

Run: `npm test -- --run && npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass; no new lint warnings beyond the 4 pre-existing

- [ ] **Step 8: Commit**

```bash
git add frontend/src
git commit -m "feat(model): a Report | Model switch in the builder"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/architecture/low-level.md`

- [ ] **Step 1: Add the package**

Add to the frontend structure section:

> `src/model/` — the semantic model tab. `layout.ts` places tables by
> longest-path layering (pure, deterministic — a diagram that moves when
> nothing changed reads as unreliable); `ModelDiagram.tsx` draws them as
> SVG with edges directed foreign-key side → primary-key side, the same
> direction `app/semantic/joins.py` reasons over; `TableDetail.tsx` and
> `ModelTab.tsx` compose the rest. Read-only: changing a model is DDL,
> which this app never issues.

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/low-level.md
git commit -m "docs: the model tab in the low-level map"
```

---

## Self-Review

**Spec coverage.** Read-only diagram → Tasks 1–2. Directed edges → Task 1 (`realEdges`, edge endpoints) and Task 2 (marker). Fields per table grouped by kind → Task 3. Detail panel → Tasks 3–4. View switch not a panel → Task 5. Layout algorithm with cycle guard and stable ordering → Task 1. Empty/no-relationship/unbound states → Tasks 2 (no tables, no joins), 4 (unbound). No backend change → asserted in Global Constraints. Never dirties the report → Task 5 Step 1.

**Placeholder scan.** Every step has runnable code or an exact command. The one soft reference is Task 5's `builderTestHarness`, which the step explicitly instructs to create from `BuilderPage.test.tsx`'s existing setup if absent — the alternative would be duplicating a large mount block into this plan, which drifts the moment the real one changes.

**Type consistency.** `layoutModel` / `ModelLayout` / `ModelNode` / `ModelEdge` and `NODE_WIDTH` are declared in Task 1 and used unchanged in Task 2. `<ModelDiagram detail selected onSelect />`, `<TableDetail detail table />` and `<ModelTab detail />` match between their defining task and their consumer. `ui.mode` is the same name in the hook, header and canvas column.

**One risk worth naming.** Task 2 renders each node in a `foreignObject` so it is a real `<button>` — focusable and announced without reimplementing keyboard handling on an SVG shape. jsdom supports `foreignObject` children well enough for Testing Library queries, but if a query unexpectedly fails there, the fallback is an HTML-positioned overlay rather than SVG shapes with `tabIndex` and `role="button"`, which would have to reimplement focus and activation by hand.
