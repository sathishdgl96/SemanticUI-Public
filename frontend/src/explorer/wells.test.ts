import { describe, expect, it } from "vitest";
import {
  addToWell, canDrop, defaultWellFor, emptyWells, removeFromWell,
  reorderWell, wellsToQuery,
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

  it("caps axis and legend at one field, replacing", () => {
    let w = addToWell(emptyWells(), "axis", "ORDERS.DATE", "dimension");
    w = addToWell(w, "axis", "CUSTOMERS.REGION", "dimension");
    expect(w.axis).toEqual(["CUSTOMERS.REGION"]);
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

  it("picks a default well: axis first, then legend", () => {
    const w = emptyWells();
    expect(defaultWellFor("metric", w)).toBe("values");
    expect(defaultWellFor("dimension", w)).toBe("axis");
    const withAxis = addToWell(w, "axis", "A.X", "dimension");
    expect(defaultWellFor("dimension", withAxis)).toBe("legend");
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
});
