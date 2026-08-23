import { describe, expect, it } from "vitest";
import { pivotLegend } from "./pivotLegend";

const RESULT = {
  columns: [
    { name: "ORDER_DATE", type: "DATE" },
    { name: "REGION", type: "TEXT" },
    { name: "REVENUE", type: "FIXED" },
  ],
  rows: [
    ["2026-01-01", "EAST", 10],
    ["2026-01-01", "WEST", 20],
    ["2026-01-02", "EAST", 30],
  ],
  truncated: false,
  sfqid: null,
  sql: "",
};

describe("pivotLegend", () => {
  it("splits one metric into a series per legend value", () => {
    const { categories, series } = pivotLegend(
      RESULT, "ORDER_DATE", "REGION", "REVENUE",
    );
    expect(categories).toEqual(["2026-01-01", "2026-01-02"]);
    expect(series.map((s) => s.name)).toEqual(["EAST", "WEST"]);
    expect(series[0].data).toEqual([10, 30]);
    expect(series[1].data).toEqual([20, null]);
  });

  it("assigns a stable colorIndex by legend order", () => {
    const { series } = pivotLegend(RESULT, "ORDER_DATE", "REGION", "REVENUE");
    expect(series.map((s) => s.colorIndex)).toEqual([0, 1]);
  });

  it("does not collide when a space-joined category+legend pair is ambiguous", () => {
    // "East Coast" + "Sales" and "East" + "Coast Sales" both stringify to
    // "East Coast Sales" under a space-joined key — a real risk for TEXT
    // dimensions like region/segment/product names.
    const AMBIGUOUS = {
      columns: [
        { name: "REGION", type: "TEXT" },
        { name: "SEGMENT", type: "TEXT" },
        { name: "REVENUE", type: "FIXED" },
      ],
      rows: [
        ["East Coast", "Sales", 100],
        ["East", "Coast Sales", 200],
      ],
      truncated: false,
      sfqid: null,
      sql: "",
    };
    const { categories, series } = pivotLegend(
      AMBIGUOUS, "REGION", "SEGMENT", "REVENUE",
    );
    expect(categories).toEqual(["East Coast", "East"]);
    expect(series.map((s) => s.name)).toEqual(["Sales", "Coast Sales"]);

    const sales = series.find((s) => s.name === "Sales")!;
    const coastSales = series.find((s) => s.name === "Coast Sales")!;
    expect(sales.data).toEqual([100, null]);
    expect(coastSales.data).toEqual([null, 200]);
  });
});
