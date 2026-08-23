import { describe, expect, it } from "vitest";
import {
  addToWell, canDrop, defaultWellFor, emptyWells, removeFromWell,
  reorderWell, visualForShape, wellsToQuery,
} from "./wells";

describe("wells model", () => {
  it("only accepts the right field kind", () => {
    expect(canDrop("axis", "dimension")).toBe(true);
    expect(canDrop("axis", "metric")).toBe(false);
    expect(canDrop("legend", "dimension")).toBe(true);
    expect(canDrop("values", "metric")).toBe(true);
    expect(canDrop("values", "dimension")).toBe(false);
  });

  it("rejects a wrong-kind add", () => {
    const w = addToWell(emptyWells(), "axis", "ORDERS.REVENUE", "metric");
    expect(w).toEqual(emptyWells());
  });

  it("groups by as many dimensions as you like", () => {
    // An explore is a query. The old one-dimension cap came from the report
    // hand-off building a bar chart, not from anything about querying.
    let w = addToWell(emptyWells(), "axis", "ORDERS.DATE", "dimension");
    w = addToWell(w, "axis", "CUSTOMERS.REGION", "dimension");
    w = addToWell(w, "axis", "PART.BRAND", "dimension");
    expect(w.axis).toEqual(["ORDERS.DATE", "CUSTOMERS.REGION", "PART.BRAND"]);
  });

  it("still allows only one legend, because a series splits one way", () => {
    let w = addToWell(emptyWells(), "legend", "A.X", "dimension");
    w = addToWell(w, "legend", "C.REGION", "dimension");
    expect(w.legend).toEqual(["C.REGION"]);
  });

  it("accumulates and de-dupes values", () => {
    let w = addToWell(emptyWells(), "values", "ORDERS.REVENUE", "metric");
    w = addToWell(w, "values", "ORDERS.COUNT", "metric");
    w = addToWell(w, "values", "ORDERS.REVENUE", "metric");
    expect(w.values).toEqual(["ORDERS.REVENUE", "ORDERS.COUNT"]);
  });

  it("removes and reorders", () => {
    let w = addToWell(emptyWells(), "values", "A.X", "metric");
    w = addToWell(w, "values", "A.Y", "metric");
    expect(reorderWell(w, "values", 0, 1).values).toEqual(["A.Y", "A.X"]);
    expect(removeFromWell(w, "values", "A.X").values).toEqual(["A.Y"]);
  });

  it("sends every clicked dimension to the group-by well", () => {
    const w = emptyWells();
    expect(defaultWellFor("metric", w)).toBe("values");
    expect(defaultWellFor("dimension", w)).toBe("axis");
    // It used to overflow into `legend` once axis held one, so a second
    // dimension silently changed the SHAPE of the chart instead of adding a
    // grouping -- and a third had nowhere to go at all.
    const withAxis = addToWell(w, "axis", "A.X", "dimension");
    expect(defaultWellFor("dimension", withAxis)).toBe("axis");
  });

  it("maps wells to a query body with axis before legend", () => {
    let w = addToWell(emptyWells(), "axis", "A.DATE", "dimension");
    w = addToWell(w, "legend", "C.REGION", "dimension");
    w = addToWell(w, "values", "A.REVENUE", "metric");
    expect(wellsToQuery(w)).toEqual({
      dimensions: ["A.DATE", "C.REGION"],
      metrics: ["A.REVENUE"],
    });
  });

  it("refuses to add a ref that is already present in a different well", () => {
    let w = addToWell(emptyWells(), "axis", "ORDERS.ORDER_DATE", "dimension");
    // Same ref, same kind, but targeting legend this time — must be a no-op
    // rather than duplicating the field across two wells.
    w = addToWell(w, "legend", "ORDERS.ORDER_DATE", "dimension");
    expect(w).toEqual({ axis: ["ORDERS.ORDER_DATE"], legend: [], values: [] });
  });

  it("treats a second click on an already-placed field as a no-op", () => {
    let w = addToWell(emptyWells(), "axis", "ORDERS.ORDER_DATE", "dimension");
    const target = defaultWellFor("dimension", w);
    w = addToWell(w, target, "ORDERS.ORDER_DATE", "dimension");
    // A ref may only occupy one well, so re-adding it changes nothing --
    // otherwise the query would name the same column twice.
    expect(w).toEqual({ axis: ["ORDERS.ORDER_DATE"], legend: [], values: [] });
  });

  it("never produces a duplicate ref across wells via wellsToQuery", () => {
    let w = addToWell(emptyWells(), "axis", "ORDERS.ORDER_DATE", "dimension");
    w = addToWell(w, "legend", "ORDERS.ORDER_DATE", "dimension");
    const { dimensions } = wellsToQuery(w);
    expect(new Set(dimensions).size).toBe(dimensions.length);
  });
});

describe("visualForShape", () => {
  it("hands off one dimension as a bar chart", () => {
    let w = addToWell(emptyWells(), "axis", "C.REGION", "dimension");
    w = addToWell(w, "values", "O.REVENUE", "metric");
    expect(visualForShape(w)).toBe("bar");
  });

  it("keeps a bar for one axis plus a legend", () => {
    let w = addToWell(emptyWells(), "axis", "C.REGION", "dimension");
    w = addToWell(w, "legend", "C.SEGMENT", "dimension");
    expect(visualForShape(w)).toBe("bar");
  });

  it("hands off several dimensions as a table", () => {
    // A bar's axis takes exactly one field, so handing it two would produce
    // a definition the server rejects.
    let w = addToWell(emptyWells(), "axis", "C.REGION", "dimension");
    w = addToWell(w, "axis", "C.SEGMENT", "dimension");
    expect(visualForShape(w)).toBe("table");
  });
});
