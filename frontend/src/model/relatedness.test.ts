import { describe, expect, it } from "vitest";
import type { SemanticViewDetail } from "../api/types";
import {
  adjacency,
  highlightFor,
  linkBetween,
  pathBetween,
  relatedFields,
} from "./relatedness";

/** LINEITEM -> ORDERS -> CUSTOMER -> NATION, and a PART nothing reaches
 *  from ORDERS except by going back down through LINEITEM. */
const DETAIL: SemanticViewDetail = {
  tables: [
    { name: "LINEITEM" },
    { name: "ORDERS" },
    { name: "CUSTOMER" },
    { name: "NATION" },
    { name: "PART" },
  ],
  relationships: [
    {
      name: "LINE_TO_ORDER",
      table: "LINEITEM",
      refTable: "ORDERS",
      foreignKey: ["L_ORDERKEY"],
      refKey: ["O_ORDERKEY"],
    },
    {
      name: "LINE_TO_PART",
      table: "LINEITEM",
      refTable: "PART",
      foreignKey: ["L_PARTKEY"],
      refKey: ["P_PARTKEY"],
    },
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
    { table: "NATION", name: "NATION_NAME", dataType: "TEXT" },
    { table: "PART", name: "BRAND", dataType: "TEXT" },
  ],
  metrics: [
    { table: "ORDERS", name: "ORDER_TOTAL", dataType: "NUMBER" },
    { table: "LINEITEM", name: "LINE_REVENUE", dataType: "NUMBER" },
  ],
  facts: [],
};

describe("adjacency", () => {
  it("is directed: foreign-key side to referenced side", () => {
    const graph = adjacency(DETAIL);
    expect(graph.get("ORDERS")?.map((h) => h.to)).toEqual(["CUSTOMER"]);
    expect(graph.get("CUSTOMER")?.map((h) => h.to)).toEqual(["NATION"]);
    // Nothing hangs off NATION -- that is what makes it a leaf dimension.
    expect(graph.get("NATION")).toEqual([]);
  });

  it("carries the columns each join is on", () => {
    expect(adjacency(DETAIL).get("ORDERS")?.[0].on).toBe("O_CUSTKEY = C_CUSTKEY");
  });

  it("ignores a relationship with an end this model does not declare", () => {
    const graph = adjacency({
      ...DETAIL,
      relationships: [{ name: "DANGLING", table: "ORDERS", refTable: "ELSEWHERE" }],
    });
    expect(graph.get("ORDERS")).toEqual([]);
    expect(graph.has("ELSEWHERE")).toBe(false);
  });
});

describe("pathBetween", () => {
  it("returns each hop, in the direction it is followed", () => {
    const path = pathBetween(adjacency(DETAIL), "ORDERS", "NATION");
    expect(path?.map((step) => `${step.from}->${step.to}`)).toEqual([
      "ORDERS->CUSTOMER",
      "CUSTOMER->NATION",
    ]);
    expect(path?.map((step) => step.on)).toEqual([
      "O_CUSTKEY = C_CUSTKEY",
      "C_NATIONKEY = N_NATIONKEY",
    ]);
  });

  it("is empty between a table and itself", () => {
    expect(pathBetween(adjacency(DETAIL), "ORDERS", "ORDERS")).toEqual([]);
  });

  it("refuses to walk an edge backwards", () => {
    // Direction is what decides answerability; a path that ignored it
    // would promise queries Snowflake rejects.
    expect(pathBetween(adjacency(DETAIL), "NATION", "ORDERS")).toBeNull();
  });
});

describe("linkBetween", () => {
  it("calls the referenced side downstream", () => {
    expect(linkBetween(adjacency(DETAIL), "ORDERS", "NATION").kind).toBe("downstream");
  });

  it("calls the referencing side upstream", () => {
    expect(linkBetween(adjacency(DETAIL), "NATION", "ORDERS").kind).toBe("upstream");
  });

  it("finds the entity that bridges two tables neither of which reaches the other", () => {
    // ORDERS and PART are siblings under LINEITEM. Naming LINEITEM is what
    // makes a query over both compile -- the same repair plan_join makes.
    const link = linkBetween(adjacency(DETAIL), "ORDERS", "PART");
    expect(link).toMatchObject({ kind: "bridged", through: "LINEITEM" });
  });

  it("reports no path when there is none", () => {
    const island: SemanticViewDetail = {
      ...DETAIL,
      tables: [{ name: "ORDERS" }, { name: "ALONE" }],
      relationships: [],
    };
    expect(linkBetween(adjacency(island), "ORDERS", "ALONE").kind).toBe("none");
  });
});

describe("relatedFields", () => {
  it("orders by how many joins away, nearest first", () => {
    const related = relatedFields(DETAIL, "ORDERS.STATUS");
    expect(related[0].ref).toBe("ORDERS.ORDER_TOTAL");
    // One join either way is one join: CUSTOMER is referenced BY ORDERS and
    // LINEITEM references it, and both are nearer than NATION two hops out.
    expect(related.map((r) => r.table)).toEqual([
      "ORDERS",
      "CUSTOMER",
      "LINEITEM",
      "NATION",
      "PART",
    ]);
  });

  it("lets a dimension be broken down by a measure that reaches it", () => {
    const related = relatedFields(DETAIL, "NATION.NATION_NAME");
    const revenue = related.find((r) => r.ref === "LINEITEM.LINE_REVENUE");
    expect(revenue?.together).toEqual({ ok: true });
  });

  it("refuses a measure too coarse for the dimension, and says why", () => {
    // ORDER_TOTAL is measured per ORDERS, and ORDERS cannot see PART:
    // the query fails at compile time with "Invalid dimension specified".
    const related = relatedFields(DETAIL, "PART.BRAND");
    const total = related.find((r) => r.ref === "ORDERS.ORDER_TOTAL");
    expect(total?.together).toEqual({
      ok: false,
      reason: "Measured per ORDERS — cannot break down by PART.",
    });
  });

  it("never blocks one dimension on another", () => {
    // The server bridges dimension-only queries through a third entity, so
    // picking one dimension rules no other one out.
    const related = relatedFields(DETAIL, "ORDERS.STATUS");
    const brand = related.find((r) => r.ref === "PART.BRAND");
    expect(brand?.link.kind).toBe("bridged");
    expect(brand?.together).toEqual({ ok: true });
  });

  it("blocks the same pair from either end", () => {
    const fromMeasure = relatedFields(DETAIL, "ORDERS.ORDER_TOTAL").find(
      (r) => r.ref === "PART.BRAND",
    );
    expect(fromMeasure?.together.ok).toBe(false);
  });

  it("excludes the selected field, and returns nothing for a field that is not there", () => {
    const related = relatedFields(DETAIL, "ORDERS.STATUS");
    expect(related.some((r) => r.ref === "ORDERS.STATUS")).toBe(false);
    expect(relatedFields(DETAIL, "ORDERS.NOT_A_FIELD")).toEqual([]);
  });
});

describe("highlightFor", () => {
  it("distinguishes the field's own table, what it joins to, and what only bridges", () => {
    const highlight = highlightFor(DETAIL, "ORDERS.STATUS");
    expect(highlight?.tables.get("ORDERS")).toBe("self");
    expect(highlight?.tables.get("CUSTOMER")).toBe("linked");
    expect(highlight?.tables.get("NATION")).toBe("linked");
    // LINEITEM references ORDERS, so it is on a path; PART only reaches it
    // by going through LINEITEM.
    expect(highlight?.tables.get("LINEITEM")).toBe("linked");
    expect(highlight?.tables.get("PART")).toBe("bridged");
  });

  it("names the relationships on those paths", () => {
    const highlight = highlightFor(DETAIL, "ORDERS.STATUS");
    expect([...(highlight?.relationships ?? [])].sort()).toEqual([
      "CUST_TO_NATION",
      "LINE_TO_ORDER",
      "LINE_TO_PART",
      "ORDER_TO_CUST",
    ]);
  });

  it("is nothing at all when no field is selected", () => {
    expect(highlightFor(DETAIL, null)).toBeNull();
  });
});
