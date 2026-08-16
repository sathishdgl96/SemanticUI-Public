import { describe, expect, it } from "vitest";
import { validateWells } from "../reports/catalog";
import {
  canRender, defaultTypeFor, effectiveType, EXPLORE_VISUALS, exploreVisual,
  unusedFields, wellsForType,
} from "./vizTypes";
import { addToWell, emptyWells, type Wells } from "./wells";

function selection(axis: string[], legend: string[], values: string[]): Wells {
  let wells = emptyWells();
  for (const ref of axis) wells = addToWell(wells, "axis", ref, "dimension");
  for (const ref of legend) wells = addToWell(wells, "legend", ref, "dimension");
  for (const ref of values) wells = addToWell(wells, "values", ref, "metric");
  return wells;
}

const ONE_BY_ONE = selection(["C.REGION"], [], ["O.REVENUE"]);

describe("EXPLORE_VISUALS", () => {
  it("offers the whole gallery except the slicer", () => {
    // A slicer is a filter control: it has no result set to draw, so it is
    // the one catalog entry that cannot be an answer to an explore.
    expect(EXPLORE_VISUALS).toContain("bar");
    expect(EXPLORE_VISUALS).toContain("treemap");
    expect(EXPLORE_VISUALS).toContain("matrix");
    expect(EXPLORE_VISUALS).not.toContain("slicer");
  });

  it("maps every offered type onto wells its own catalog spec accepts", () => {
    // The mapping and the catalog are separate pieces that must agree; this
    // is what stops a type being offered as a button that always refuses.
    const rich = selection(["C.REGION"], ["C.SEGMENT"], ["O.REVENUE", "O.COST"]);
    const renderable = EXPLORE_VISUALS.filter((type) => canRender(type, rich));
    for (const type of renderable) {
      expect(validateWells(type, wellsForType(type, rich))).toEqual([]);
    }
    // And enough of them work on an ordinary selection to be worth a picker.
    expect(renderable.length).toBeGreaterThan(5);
  });
});

describe("wellsForType", () => {
  it("puts the first dimension in the category well for one-by-one charts", () => {
    // A pie takes its category from Legend, but a user drops dimensions in
    // Group by. Reading only `legend` would leave every pie empty.
    expect(wellsForType("pie", ONE_BY_ONE)).toEqual({
      legend: ["C.REGION"],
      values: ["O.REVENUE"],
    });
  });

  it("gives a scatter two measures for its axes and a dimension for detail", () => {
    const wells = selection(["C.REGION"], [], ["O.REVENUE", "O.COST"]);
    expect(wellsForType("scatter", wells)).toEqual({
      x: ["O.REVENUE"],
      y: ["O.COST"],
      detail: ["C.REGION"],
    });
  });

  it("gives a matrix every dimension as rows, not just the first", () => {
    const wells = selection(["C.REGION", "C.COUNTRY"], ["C.SEGMENT"], ["O.REVENUE"]);
    expect(wellsForType("matrix", wells)).toEqual({
      rows: ["C.REGION", "C.COUNTRY"],
      columns: ["C.SEGMENT"],
      values: ["O.REVENUE"],
    });
  });

  it("keeps a bar to one axis field, because that is all a bar has", () => {
    const wells = selection(["C.REGION", "C.COUNTRY"], [], ["O.REVENUE"]);
    expect(wellsForType("bar", wells).axis).toEqual(["C.REGION"]);
  });
});

describe("canRender", () => {
  it("refuses a pie with no measure", () => {
    expect(canRender("pie", selection(["C.REGION"], [], []))).toBe(false);
  });

  it("refuses a scatter with only one measure", () => {
    expect(canRender("scatter", ONE_BY_ONE)).toBe(false);
    expect(canRender("scatter", selection([], [], ["O.REVENUE", "O.COST"]))).toBe(true);
  });

  it("allows a table with dimensions and no measure", () => {
    expect(canRender("table", selection(["C.REGION"], [], []))).toBe(true);
  });
});

describe("unusedFields", () => {
  it("names the measures a one-measure chart leaves out", () => {
    // The pie is valid and charts the first measure. What makes that
    // acceptable is saying so -- otherwise it answers a narrower question
    // than the selection on screen implies.
    const two = selection(["C.REGION"], [], ["O.REVENUE", "O.COST"]);
    expect(canRender("pie", two)).toBe(true);
    expect(unusedFields("pie", two)).toEqual(["O.COST"]);
  });

  it("is empty when the type has room for everything selected", () => {
    expect(unusedFields("table", selection(["C.REGION"], [], ["O.REVENUE"]))).toEqual([]);
    expect(unusedFields("bar", ONE_BY_ONE)).toEqual([]);
  });

  it("names dimensions a bar cannot put on its single axis", () => {
    const wells = selection(["C.REGION", "C.COUNTRY"], [], ["O.REVENUE"]);
    expect(unusedFields("bar", wells)).toEqual(["C.COUNTRY"]);
  });
});

describe("effectiveType", () => {
  it("falls back when the chosen type cannot draw the selection at all", () => {
    // A scatter needs two measures for its two axes. With one, there is no
    // chart to draw -- as opposed to a pie with two measures, which draws a
    // valid chart of the first.
    const oneMeasure = ONE_BY_ONE;
    expect(canRender("scatter", oneMeasure)).toBe(false);
    expect(effectiveType("scatter", oneMeasure)).toBe("bar");
  });

  it("keeps the chosen type while it still works", () => {
    expect(effectiveType("pie", ONE_BY_ONE)).toBe("pie");
  });

  it("defaults to a table once there is more than one dimension", () => {
    expect(defaultTypeFor(ONE_BY_ONE)).toBe("bar");
    expect(defaultTypeFor(selection(["A.X", "B.Y"], [], ["O.REVENUE"]))).toBe("table");
    // Nothing to measure: a chart would have no series, so show the rows.
    expect(defaultTypeFor(selection(["A.X"], [], []))).toBe("table");
  });
});

describe("exploreVisual", () => {
  it("is a report visual, so the hand-off gives you what you were looking at", () => {
    const visual = exploreVisual("pie", ONE_BY_ONE);
    expect(visual.type).toBe("pie");
    expect(visual.wells).toEqual({ legend: ["C.REGION"], values: ["O.REVENUE"] });
    expect(visual.filters).toEqual([]);
  });
});
