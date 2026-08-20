import { describe, expect, it } from "vitest";
import { nextSort, sortRows } from "./sortRows";

const COLUMNS = [
  { name: "REGION", type: "TEXT" },
  { name: "REVENUE", type: "NUMBER" },
];

const ROWS: unknown[][] = [
  ["EUROPE", 30],
  ["ASIA", 13],
  ["AFRICA", 200],
];

describe("nextSort", () => {
  it("starts ascending on a fresh column", () => {
    expect(nextSort(null, 1)).toEqual({ index: 1, direction: "asc" });
  });

  it("goes ascending then descending then back to the query's own order", () => {
    const asc = nextSort(null, 1);
    const desc = nextSort(asc, 1);
    expect(desc).toEqual({ index: 1, direction: "desc" });
    // A third click restores what the query returned, which is itself
    // meaningful -- it is the ordering the semantic layer chose.
    expect(nextSort(desc, 1)).toBeNull();
  });

  it("starts over when a different column is clicked", () => {
    const desc = { index: 1, direction: "desc" } as const;
    expect(nextSort(desc, 0)).toEqual({ index: 0, direction: "asc" });
  });
});

describe("sortRows", () => {
  it("leaves the rows alone when nothing is sorted", () => {
    expect(sortRows(ROWS, null, COLUMNS)).toEqual(ROWS);
  });

  it("sorts numbers by value, not by their text", () => {
    const sorted = sortRows(ROWS, { index: 1, direction: "asc" }, COLUMNS);
    expect(sorted.map((r) => r[1])).toEqual([13, 30, 200]);
  });

  it("sorts text case-insensitively", () => {
    const rows: unknown[][] = [["beta", 1], ["Alpha", 2]];
    const sorted = sortRows(rows, { index: 0, direction: "asc" }, COLUMNS);
    expect(sorted.map((r) => r[0])).toEqual(["Alpha", "beta"]);
  });

  it("descends", () => {
    const sorted = sortRows(ROWS, { index: 1, direction: "desc" }, COLUMNS);
    expect(sorted.map((r) => r[1])).toEqual([200, 30, 13]);
  });

  it("puts blanks last in both directions, so they never crowd the top", () => {
    const rows: unknown[][] = [["A", 5], ["B", null], ["C", 1]];
    expect(
      sortRows(rows, { index: 1, direction: "asc" }, COLUMNS).map((r) => r[0]),
    ).toEqual(["C", "A", "B"]);
    expect(
      sortRows(rows, { index: 1, direction: "desc" }, COLUMNS).map((r) => r[0]),
    ).toEqual(["A", "C", "B"]);
  });

  it("does not mutate what it was given", () => {
    const rows = [...ROWS];
    sortRows(rows, { index: 1, direction: "asc" }, COLUMNS);
    expect(rows).toEqual(ROWS);
  });

  it("is stable, so equal values keep the query's order", () => {
    const rows: unknown[][] = [["first", 1], ["second", 1], ["third", 1]];
    const sorted = sortRows(rows, { index: 1, direction: "asc" }, COLUMNS);
    expect(sorted.map((r) => r[0])).toEqual(["first", "second", "third"]);
  });
});
