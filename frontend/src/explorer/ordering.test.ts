import { describe, expect, it } from "vitest";
import { applyOrder, orderByFor, pruneOrderBy, sortStateFor } from "./ordering";

const columns = [
  { name: "ORDER_DATE", type: "DATE" },
  { name: "REVENUE", type: "NUMBER" },
];
const refs = ["ORDERS.ORDER_DATE", "ORDERS.REVENUE"];

describe("sortStateFor", () => {
  it("shows the ordered field's column as sorted", () => {
    expect(sortStateFor(columns, [{ field: "ORDERS.REVENUE", direction: "desc" }])).toEqual({
      index: 1,
      direction: "desc",
    });
  });

  it("is case-blind, because Snowflake answers in its own casing", () => {
    expect(sortStateFor(columns, [{ field: "orders.revenue", direction: "asc" }])).toEqual({
      index: 1,
      direction: "asc",
    });
  });

  it("is nothing for no sort, or for a field that is not a column", () => {
    expect(sortStateFor(columns, [])).toBeNull();
    expect(sortStateFor(columns, [{ field: "ORDERS.GONE", direction: "asc" }])).toBeNull();
  });
});

describe("orderByFor", () => {
  it("names the clicked column by the reference it was selected by", () => {
    expect(orderByFor(columns, { index: 0, direction: "asc" }, refs)).toEqual([
      { field: "ORDERS.ORDER_DATE", direction: "asc" },
    ]);
  });

  it("is empty for no sort or an unmapped column", () => {
    expect(orderByFor(columns, null, refs)).toEqual([]);
    expect(orderByFor(columns, { index: 5, direction: "asc" }, refs)).toEqual([]);
    expect(orderByFor(columns, { index: 0, direction: "asc" }, ["OTHER.THING"])).toEqual([]);
  });
});

describe("pruneOrderBy", () => {
  it("drops a sort whose field is no longer selected", () => {
    const orderBy = [{ field: "ORDERS.REVENUE", direction: "desc" as const }];
    expect(pruneOrderBy(orderBy, refs)).toEqual(orderBy);
    expect(pruneOrderBy(orderBy, ["ORDERS.ORDER_DATE"])).toEqual([]);
  });
});

describe("applyOrder", () => {
  const result = {
    columns,
    rows: [
      ["2026-03-01", 30],
      ["2026-01-01", 10],
      ["2026-02-01", 20],
    ] as unknown[][],
  };

  it("puts the rows in the order asked for, by the column's type", () => {
    const byDate = applyOrder(result, [{ field: "ORDERS.ORDER_DATE", direction: "asc" }]);
    expect(byDate.rows.map((r) => r[0])).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    const byRevenue = applyOrder(result, [{ field: "ORDERS.REVENUE", direction: "desc" }]);
    expect(byRevenue.rows.map((r) => r[1])).toEqual([30, 20, 10]);
  });

  it("leaves the query's own order alone when there is no sort", () => {
    expect(applyOrder(result, [])).toBe(result);
  });
});
