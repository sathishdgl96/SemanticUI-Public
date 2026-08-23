import { describe, expect, it } from "vitest";
import { queryFieldsFor } from "./vizTypes";
import { addToWell, emptyWells, type Wells } from "./wells";

function selection(axis: string[], legend: string[], values: string[]): Wells {
  let wells = emptyWells();
  for (const ref of axis) wells = addToWell(wells, "axis", ref, "dimension");
  for (const ref of legend) wells = addToWell(wells, "legend", ref, "dimension");
  for (const ref of values) wells = addToWell(wells, "values", ref, "metric");
  return wells;
}

/** The query must group by what the VISUAL draws, not by everything
 *  selected. Grouping by a dimension the visual has no room for splits
 *  each category across several rows, so a pie drew the same label twice
 *  with half its value each time, and a gauge showed one arbitrary row. */
describe("queryFieldsFor", () => {
  it("gives a bar both dimensions, because it draws both", () => {
    const wells = selection(["C.REGION", "C.SEGMENT"], [], ["O.REVENUE"]);
    expect(queryFieldsFor("bar", wells)).toEqual({
      dimensions: ["C.REGION", "C.SEGMENT"],
      metrics: ["O.REVENUE"],
    });
  });

  it("gives a pie only the dimension it can draw", () => {
    const wells = selection(["C.REGION", "C.SEGMENT"], [], ["O.REVENUE"]);
    expect(queryFieldsFor("pie", wells)).toEqual({
      dimensions: ["C.REGION"],
      metrics: ["O.REVENUE"],
    });
  });

  it("gives funnel and treemap the same single dimension", () => {
    const wells = selection(["C.REGION", "C.SEGMENT"], [], ["O.REVENUE"]);
    for (const type of ["funnel", "treemap", "donut"] as const) {
      expect(queryFieldsFor(type, wells).dimensions).toEqual(["C.REGION"]);
    }
  });

  it("gives a gauge no dimensions at all, so it reads one total", () => {
    const wells = selection(["C.REGION"], [], ["O.REVENUE"]);
    expect(queryFieldsFor("gauge", wells)).toEqual({
      dimensions: [],
      metrics: ["O.REVENUE"],
    });
  });

  it("gives a kpi no dimensions either", () => {
    const wells = selection(["C.REGION"], [], ["O.REVENUE"]);
    expect(queryFieldsFor("kpi", wells).dimensions).toEqual([]);
  });

  it("gives a table and a matrix every dimension selected", () => {
    const wells = selection(["C.REGION", "C.SEGMENT"], [], ["O.REVENUE"]);
    expect(queryFieldsFor("table", wells).dimensions).toEqual([
      "C.REGION",
      "C.SEGMENT",
    ]);
    expect(queryFieldsFor("matrix", wells).dimensions).toEqual([
      "C.REGION",
      "C.SEGMENT",
    ]);
  });

  it("never returns a field twice, whatever the well layout", () => {
    const wells = selection(["C.REGION"], ["C.SEGMENT"], ["O.REVENUE"]);
    const { dimensions } = queryFieldsFor("bar", wells);
    expect(new Set(dimensions).size).toBe(dimensions.length);
  });
});
