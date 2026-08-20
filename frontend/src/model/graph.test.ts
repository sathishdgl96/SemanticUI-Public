import { describe, expect, it } from "vitest";
import type { SemanticViewDetail } from "../api/types";
import {
  buildGraph,
  columnsByTable,
  handleId,
  NODE_WIDTH,
  PREVIEW_ROWS,
  realEdges,
} from "./graph";

const DETAIL: SemanticViewDetail = {
  tables: [{ name: "ORDERS" }, { name: "CUSTOMER" }, { name: "NATION" }],
  relationships: [
    {
      name: "ORDER_TO_CUST",
      table: "ORDERS",
      refTable: "CUSTOMER",
      foreignKey: ["O_CUSTKEY"],
      refKey: ["C_CUSTKEY"],
    },
    {
      name: "CUST_TO_NATION",
      table: "CUSTOMER",
      refTable: "NATION",
      foreignKey: ["C_NATIONKEY"],
      refKey: ["N_NATIONKEY"],
    },
  ],
  dimensions: [
    { table: "ORDERS", name: "STATUS", dataType: "TEXT" },
    { table: "CUSTOMER", name: "SEGMENT", dataType: "TEXT" },
  ],
  metrics: [{ table: "ORDERS", name: "REVENUE", dataType: "NUMBER" }],
  facts: [],
};

describe("realEdges", () => {
  it("drops a relationship with an end this model does not declare", () => {
    // A dangling end would anchor an edge to a node that is never drawn.
    const edges = realEdges({
      ...DETAIL,
      relationships: [
        ...DETAIL.relationships,
        { name: "DANGLING", table: "ORDERS", refTable: "ELSEWHERE" },
      ],
    });
    expect(edges.map((e) => e.name)).toEqual(["CUST_TO_NATION", "ORDER_TO_CUST"]);
  });
});

describe("columnsByTable", () => {
  it("lists join keys first, then the modelled fields", () => {
    const columns = columnsByTable(DETAIL);
    expect(columns.get("ORDERS")?.map((c) => c.name)).toEqual([
      "O_CUSTKEY",
      "STATUS",
      "REVENUE",
    ]);
  });

  it("gives a join key no ref, because it is not a queryable field", () => {
    // FOREIGN_KEY names a physical column of the underlying table; the
    // semantic view's fields are expressions over those. Offering one as
    // selectable would offer a query that cannot be written.
    const key = columnsByTable(DETAIL).get("ORDERS")?.[0];
    expect(key).toMatchObject({ name: "O_CUSTKEY", kind: "key", ref: null });
    expect(columnsByTable(DETAIL).get("ORDERS")?.[1].ref).toBe("ORDERS.STATUS");
  });

  it("carries a key on both sides of the join it belongs to", () => {
    const columns = columnsByTable(DETAIL);
    expect(columns.get("CUSTOMER")?.map((c) => c.name)).toEqual([
      "C_CUSTKEY",
      "C_NATIONKEY",
      "SEGMENT",
    ]);
  });

  it("includes a table with no fields at all", () => {
    expect(columnsByTable({ ...DETAIL, dimensions: [], metrics: [], facts: [] }).size).toBe(
      3,
    );
  });
});

describe("buildGraph", () => {
  it("places every table, with no two cards overlapping", () => {
    const { nodes } = buildGraph(DETAIL);
    expect(nodes.map((n) => n.id)).toEqual(["CUSTOMER", "NATION", "ORDERS"]);
    for (const a of nodes) {
      for (const b of nodes) {
        if (a.id >= b.id) continue;
        const apart =
          Math.abs(a.position.x - b.position.x) >= NODE_WIDTH ||
          Math.abs(a.position.y - b.position.y) >=
            Math.max(a.height as number, b.height as number);
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
  });

  it("is deterministic: the same model lays out identically every time", () => {
    // A diagram that rearranges itself when nothing changed reads as
    // unreliable rather than as informative.
    expect(buildGraph(DETAIL).nodes.map((n) => n.position)).toEqual(
      buildGraph(DETAIL).nodes.map((n) => n.position),
    );
  });

  it("does not lay a chain out as a single row", () => {
    // The whole point of using the pane: a three-table chain that comes
    // out as one flat line wastes every pixel above and below it.
    const { nodes } = buildGraph(DETAIL);
    expect(new Set(nodes.map((n) => Math.round(n.position.x))).size).toBeGreaterThan(1);
  });

  it("anchors an edge to the key column the join is declared on", () => {
    const { edges, nodes } = buildGraph(DETAIL);
    const edge = edges.find((e) => e.id === "ORDER_TO_CUST")!;
    const forward =
      (nodes.find((n) => n.id === "CUSTOMER")?.position.x ?? 0) >=
      (nodes.find((n) => n.id === "ORDERS")?.position.x ?? 0);
    expect(edge.sourceHandle).toBe(
      handleId("source", forward ? "right" : "left", "O_CUSTKEY"),
    );
    expect(edge.targetHandle).toBe(
      handleId("target", forward ? "left" : "right", "C_CUSTKEY"),
    );
  });

  it("marks many at the foreign key and one at the referenced key", () => {
    // Snowflake declares a foreign key against a referenced key, which is
    // many-to-one by construction, and reports no cardinality of its own --
    // so one-to-one is never claimed.
    const edge = buildGraph(DETAIL).edges[0];
    expect(edge.markerStart).toContain("model-many");
    expect(edge.markerEnd).toContain("model-one");
    expect(edge.data?.on).toBe("C_NATIONKEY = N_NATIONKEY");
  });

  it("falls back to the card's own anchor when the describe carried no keys", () => {
    const { edges } = buildGraph({
      ...DETAIL,
      relationships: [{ name: "R", table: "ORDERS", refTable: "CUSTOMER" }],
    });
    expect(edges[0].sourceHandle).toContain(":");
    expect(edges[0].sourceHandle?.endsWith(":")).toBe(true);
    expect(edges[0].data?.on).toBeNull();
  });

  it("caps a wide table's rows, and counts what it left out", () => {
    const wide: SemanticViewDetail = {
      ...DETAIL,
      dimensions: Array.from({ length: PREVIEW_ROWS + 5 }, (_, i) => ({
        table: "ORDERS",
        name: `D${i}`,
        dataType: "TEXT",
      })),
      metrics: [],
    };
    const node = buildGraph(wide).nodes.find((n) => n.id === "ORDERS")!;
    // The key still shows: an edge anchors to it, so hiding it would leave
    // the edge with nothing to attach to.
    expect(node.data.columns.filter((c) => c.kind === "key")).toHaveLength(1);
    expect(node.data.columns.filter((c) => c.kind !== "key")).toHaveLength(PREVIEW_ROWS);
    expect(node.data.hidden).toBe(5);
  });

  it("shows every field once the table is expanded, and grows the card", () => {
    const wide: SemanticViewDetail = {
      ...DETAIL,
      dimensions: Array.from({ length: PREVIEW_ROWS + 5 }, (_, i) => ({
        table: "ORDERS",
        name: `D${i}`,
        dataType: "TEXT",
      })),
      metrics: [],
    };
    const collapsed = buildGraph(wide).nodes.find((n) => n.id === "ORDERS")!;
    const expanded = buildGraph(wide, new Set(["ORDERS"])).nodes.find(
      (n) => n.id === "ORDERS",
    )!;
    expect(expanded.data.hidden).toBe(0);
    expect(expanded.height as number).toBeGreaterThan(collapsed.height as number);
  });

  it("calls a table that references another a fact, and one only referenced a dimension", () => {
    const kinds = new Map(buildGraph(DETAIL).nodes.map((n) => [n.id, n.data.kind]));
    expect(kinds.get("ORDERS")).toBe("fact");
    expect(kinds.get("CUSTOMER")).toBe("fact");
    expect(kinds.get("NATION")).toBe("dimension");
  });

  it("returns nothing for a view that declares no tables", () => {
    expect(buildGraph({ ...DETAIL, tables: [], relationships: [] })).toEqual({
      nodes: [],
      edges: [],
    });
  });
});
