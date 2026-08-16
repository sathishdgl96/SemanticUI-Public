import { describe, expect, it } from "vitest";
import type { SemanticViewDetail } from "../api/types";
import { availability, joinGraph, reachable } from "./joins";
import { addToWell, emptyWells } from "./wells";

// The TPCH shape, which is what every rule in joins.ts was verified against.
const DETAIL: SemanticViewDetail = {
  tables: ["CUSTOMERS", "LINEITEMS", "NATION", "ORDERS", "PART", "REGION", "SUPPLIER"].map(
    (name) => ({ name }),
  ),
  relationships: [
    { name: "CUSTOMERS_TO_NATION", table: "CUSTOMERS", refTable: "NATION" },
    { name: "LINEITEMS_TO_ORDERS", table: "LINEITEMS", refTable: "ORDERS" },
    { name: "LINEITEMS_TO_PART", table: "LINEITEMS", refTable: "PART" },
    { name: "LINEITEMS_TO_SUPPLIER", table: "LINEITEMS", refTable: "SUPPLIER" },
    { name: "NATION_TO_REGION", table: "NATION", refTable: "REGION" },
    { name: "ORDERS_TO_CUSTOMERS", table: "ORDERS", refTable: "CUSTOMERS" },
  ],
  dimensions: [
    { table: "CUSTOMERS", name: "CUSTOMER_NAME", dataType: "VARCHAR" },
    { table: "NATION", name: "NATION_NAME", dataType: "VARCHAR" },
    { table: "ORDERS", name: "ORDER_DATE", dataType: "DATE" },
    { table: "PART", name: "BRAND", dataType: "VARCHAR" },
    { table: "REGION", name: "REGION_NAME", dataType: "VARCHAR" },
    { table: "SUPPLIER", name: "SUPPLIER_NAME", dataType: "VARCHAR" },
  ],
  metrics: [
    { table: "CUSTOMERS", name: "CUSTOMER_COUNT", dataType: "NUMBER" },
    { table: "LINEITEMS", name: "TOTAL_QUANTITY", dataType: "NUMBER" },
    { table: "ORDERS", name: "ORDER_COUNT", dataType: "NUMBER" },
  ],
  facts: [],
};

describe("joinGraph", () => {
  it("directs edges from the foreign-key side to the primary-key side", () => {
    const graph = joinGraph(DETAIL);
    expect(graph.get("LINEITEMS")).toEqual(new Set(["ORDERS", "PART", "SUPPLIER"]));
    expect(graph.get("REGION")).toEqual(new Set());
  });

  it("reaches transitively, and never past an edge that does not exist", () => {
    const graph = joinGraph(DETAIL);
    expect(reachable(graph, "LINEITEMS").size).toBe(7);
    // The asymmetry IS the grain rule: coarse entities see almost nothing.
    expect(reachable(graph, "REGION")).toEqual(new Set(["REGION"]));
  });
});

describe("availability", () => {
  it("offers everything when nothing is selected", () => {
    const blocked = availability(DETAIL, emptyWells());
    expect(blocked.size).toBe(0);
  });

  it("keeps every dimension addable, because a bridge can join any of them", () => {
    // This is the whole point of the bridging the server does: in a model
    // with a fact table under everything, no two dimensions are ever
    // incompatible, so picking one never closes off another.
    const wells = addToWell(emptyWells(), "axis", "PART.BRAND", "dimension");
    const blocked = availability(DETAIL, wells);
    expect(blocked.has("SUPPLIER.SUPPLIER_NAME")).toBe(false);
    expect(blocked.has("REGION.REGION_NAME")).toBe(false);
  });

  it("blocks measures that cannot reach a selected dimension", () => {
    const wells = addToWell(emptyWells(), "axis", "PART.BRAND", "dimension");
    const blocked = availability(DETAIL, wells);
    // Neither CUSTOMERS nor ORDERS can see PART -- only LINEITEMS, which
    // sits under both.
    expect(blocked.get("CUSTOMERS.CUSTOMER_COUNT")).toMatch(/PART\.BRAND/);
    expect(blocked.get("ORDERS.ORDER_COUNT")).toMatch(/PART\.BRAND/);
    expect(blocked.has("LINEITEMS.TOTAL_QUANTITY")).toBe(false);
  });

  it("blocks dimensions a selected measure cannot break down", () => {
    const wells = addToWell(emptyWells(), "values", "CUSTOMERS.CUSTOMER_COUNT", "metric");
    const blocked = availability(DETAIL, wells);
    expect(blocked.get("ORDERS.ORDER_DATE")).toMatch(/CUSTOMERS\.CUSTOMER_COUNT/);
    expect(blocked.get("PART.BRAND")).toMatch(/CUSTOMERS\.CUSTOMER_COUNT/);
    // Coarser than CUSTOMERS, so still reachable and still on offer.
    expect(blocked.has("NATION.NATION_NAME")).toBe(false);
    expect(blocked.has("REGION.REGION_NAME")).toBe(false);
  });

  it("never blocks a field that is already selected", () => {
    // Otherwise a selection could render its own chips unremovable-looking,
    // and the field row would contradict the well beside it.
    let wells = addToWell(emptyWells(), "axis", "ORDERS.ORDER_DATE", "dimension");
    wells = addToWell(wells, "values", "CUSTOMERS.CUSTOMER_COUNT", "metric");
    const blocked = availability(DETAIL, wells);
    expect(blocked.has("ORDERS.ORDER_DATE")).toBe(false);
  });

  it("says nothing at all when the view declares no join endpoints", () => {
    // A server old enough to send relationship names only. Greying fields out
    // on the strength of a graph we do not have would be worse than the
    // occasional error.
    const stale = { ...DETAIL, relationships: [] };
    const wells = addToWell(emptyWells(), "values", "CUSTOMERS.CUSTOMER_COUNT", "metric");
    expect(availability(stale, wells).size).toBe(0);
  });

  it("reports the measure that blocks, not merely that something did", () => {
    const wells = addToWell(emptyWells(), "values", "CUSTOMERS.CUSTOMER_COUNT", "metric");
    expect(availability(DETAIL, wells).get("PART.BRAND")).toBe(
      "Not available with CUSTOMERS.CUSTOMER_COUNT selected — it is measured per CUSTOMERS.",
    );
  });
});
