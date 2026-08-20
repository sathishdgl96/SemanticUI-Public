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
