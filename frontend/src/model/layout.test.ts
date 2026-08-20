import { describe, expect, it } from "vitest";
import { layoutModel, NODE_HEIGHT, NODE_WIDTH } from "./layout";
import type { ModelNode } from "./layout";
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

const STAR_TABLES = [
  "LINEITEMS", "ORDERS", "PART", "SUPPLIER", "CUSTOMERS", "NATION", "REGION",
];

/** The TPCH shape a real semantic view has: one fact joined to several
 *  dimensions, one of which chains outwards. Every table carries columns,
 *  because a card's height depends on them and a fixture without any
 *  would measure a shape the product never draws. */
const STAR = model(
  STAR_TABLES,
  [
    { name: "li_ord", table: "LINEITEMS", refTable: "ORDERS" },
    { name: "li_part", table: "LINEITEMS", refTable: "PART" },
    { name: "li_supp", table: "LINEITEMS", refTable: "SUPPLIER" },
    { name: "ord_cust", table: "ORDERS", refTable: "CUSTOMERS" },
    { name: "cust_nat", table: "CUSTOMERS", refTable: "NATION" },
    { name: "nat_reg", table: "NATION", refTable: "REGION" },
  ],
  STAR_TABLES.flatMap((table) =>
    ["A", "B", "C", "D"].map((suffix) => ({ table, name: `${table}_${suffix}` })),
  ),
);

function ringOf(nodes: ModelNode[], name: string): number {
  return nodes.find((n) => n.name === name)!.ring;
}

function overlaps(a: ModelNode, b: ModelNode): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

describe("layoutModel", () => {
  it("puts the most connected table at the centre", () => {
    // The fact table, in every star schema. Centring it is what turns a
    // long thin chain into a shape that uses the screen.
    const { nodes } = layoutModel(STAR);
    expect(ringOf(nodes, "LINEITEMS")).toBe(0);
  });

  it("rings the tables joined to it around it", () => {
    const { nodes } = layoutModel(STAR);
    expect(ringOf(nodes, "ORDERS")).toBe(1);
    expect(ringOf(nodes, "PART")).toBe(1);
    expect(ringOf(nodes, "SUPPLIER")).toBe(1);
  });

  it("pushes each further join outwards a ring at a time", () => {
    const { nodes } = layoutModel(STAR);
    expect(ringOf(nodes, "CUSTOMERS")).toBe(2);
    expect(ringOf(nodes, "NATION")).toBe(3);
    expect(ringOf(nodes, "REGION")).toBe(4);
  });

  it("spreads rather than running in a line", () => {
    // The failure this replaces: strict left-to-right layering drew every
    // table in one row, so the diagram was a strip and most of the pane
    // was empty.
    //
    // Four of these seven tables form a chain, and a chain is linear
    // however it is drawn -- folding it to square the diagram up would
    // misrepresent the topology. So the bar is "clearly two-dimensional",
    // not "square": several rows deep, and no worse than four to one.
    // Fit-to-screen and dragging cover the rest.
    const { width, height } = layoutModel(STAR);
    expect(height).toBeGreaterThan(NODE_HEIGHT * 1.5);
    expect(width).toBeGreaterThan(NODE_WIDTH * 3);
    expect(width / height).toBeLessThan(4);
  });

  it("uses more than one row and more than one column", () => {
    // The direct statement of "not a line": tables sit at several
    // distinct heights as well as several distinct positions across.
    const { nodes } = layoutModel(STAR);
    const rows = new Set(nodes.map((n) => Math.round(n.y / 80)));
    const columns = new Set(nodes.map((n) => Math.round(n.x / 120)));
    expect(rows.size).toBeGreaterThan(2);
    expect(columns.size).toBeGreaterThan(2);
  });

  it("uses the width more than the height, to match a landscape pane", () => {
    const { width, height } = layoutModel(STAR);
    expect(width).toBeGreaterThan(height);
  });

  it("never overlaps two tables", () => {
    const { nodes } = layoutModel(STAR);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        expect(overlaps(nodes[i], nodes[j])).toBe(false);
      }
    }
  });

  it("never overlaps them even with many on one ring", () => {
    const wide = model(
      ["HUB", ...Array.from({ length: 9 }, (_, i) => `DIM${i}`)],
      Array.from({ length: 9 }, (_, i) => ({
        name: `r${i}`, table: "HUB", refTable: `DIM${i}`,
      })),
    );
    const { nodes } = layoutModel(wide);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        expect(overlaps(nodes[i], nodes[j])).toBe(false);
      }
    }
  });

  it("is deterministic, so the diagram never moves on its own", () => {
    expect(layoutModel(STAR)).toEqual(layoutModel(STAR));
  });

  it("breaks a tie for the centre by name", () => {
    const tied = model(["ZEBRA", "ALPHA"], [
      { name: "r", table: "ZEBRA", refTable: "ALPHA" },
    ]);
    expect(ringOf(layoutModel(tied).nodes, "ALPHA")).toBe(0);
  });

  it("places a table joined to nothing rather than dropping it", () => {
    const stray = model(["HUB", "NEAR", "ORPHAN"], [
      { name: "r", table: "HUB", refTable: "NEAR" },
    ]);
    const { nodes } = layoutModel(stray);
    expect(nodes.map((n) => n.name).sort()).toEqual(["HUB", "NEAR", "ORPHAN"]);
    expect(ringOf(nodes, "ORPHAN")).toBeGreaterThan(ringOf(nodes, "NEAR"));
  });

  it("places every table exactly once even if the model declares a cycle", () => {
    const cyclic = model(["A", "B"], [
      { name: "a", table: "A", refTable: "B" },
      { name: "b", table: "B", refTable: "A" },
    ]);
    expect(layoutModel(cyclic).nodes.map((n) => n.name)).toEqual(["A", "B"]);
  });

  it("still places tables when nothing is joined at all", () => {
    const { nodes } = layoutModel(model(["A", "B", "C"]));
    expect(nodes).toHaveLength(3);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        expect(overlaps(nodes[i], nodes[j])).toBe(false);
      }
    }
  });

  it("marks a table that points at another as fact-like", () => {
    const { nodes } = layoutModel(STAR);
    expect(nodes.find((n) => n.name === "LINEITEMS")!.kind).toBe("fact");
    expect(nodes.find((n) => n.name === "REGION")!.kind).toBe("dimension");
  });

  it("counts the fields each table carries", () => {
    const counted = model(["ORDERS"], [], [
      { table: "ORDERS", name: "STATUS" },
      { table: "ORDERS", name: "DATE" },
    ]);
    expect(layoutModel(counted).nodes[0].fieldCount).toBe(2);
  });

  it("drops a relationship whose endpoints are not both real tables", () => {
    const dangling = model(["A"], [
      { name: "gone", table: "A", refTable: "MISSING" },
    ]);
    expect(layoutModel(dangling).edges).toEqual([]);
  });

  it("gives an empty model an empty layout rather than throwing", () => {
    expect(layoutModel(model([]))).toMatchObject({
      nodes: [], edges: [], width: 0, height: 0,
    });
  });

  it("sizes the canvas to hold every node", () => {
    const { nodes, width, height } = layoutModel(STAR);
    for (const node of nodes) {
      expect(node.x + node.width).toBeLessThanOrEqual(width);
      expect(node.y + node.height).toBeLessThanOrEqual(height);
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
    }
    expect(width).toBeGreaterThanOrEqual(NODE_WIDTH);
  });
});
