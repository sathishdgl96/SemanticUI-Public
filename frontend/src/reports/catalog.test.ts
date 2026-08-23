import { describe, expect, it } from "vitest";
import {
  CATALOG,
  defaultWellFor,
  emptyWellsFor,
  validateWells,
  wellsToQuery,
} from "./catalog";

describe("visual catalog", () => {
  it("offers the full gallery", () => {
    expect(Object.keys(CATALOG).sort()).toEqual([
      "area",
      "bar",
      "combo",
      "donut",
      "funnel",
      "gauge",
      "hbar",
      "kpi",
      "line",
      "matrix",
      "multiCard",
      "pie",
      "scatter",
      "slicer",
      "table",
      "treemap",
    ]);
  });

  it("gives every type at least one well of a kind it can be built from", () => {
    // A type with no well at all could be added from the gallery and then
    // never accept a field, which reads as a broken tile rather than an
    // empty one.
    for (const [type, spec] of Object.entries(CATALOG)) {
      expect(spec.wells.length, `${type} has no wells`).toBeGreaterThan(0);
      expect(spec.label, `${type} has no label`).toBeTruthy();
      expect(spec.glyph, `${type} has no glyph`).toBeTruthy();
    }
  });

  it("maps combo's two measure wells into one metric list, columns first", () => {
    expect(
      wellsToQuery("combo", {
        axis: ["A.DATE"],
        values: ["A.REV"],
        lineValues: ["A.MARGIN"],
      }),
    ).toEqual({ dimensions: ["A.DATE"], metrics: ["A.REV", "A.MARGIN"] });
  });

  it("treats a matrix as rows then columns, then its measures", () => {
    expect(
      wellsToQuery("matrix", {
        rows: ["C.REGION"],
        columns: ["C.SEGMENT"],
        values: ["A.REV"],
      }),
    ).toEqual({ dimensions: ["C.REGION", "C.SEGMENT"], metrics: ["A.REV"] });
  });

  it("gives a slicer one dimension well and no measure", () => {
    expect(wellsToQuery("slicer", { field: ["C.REGION"] })).toEqual({
      dimensions: ["C.REGION"],
      metrics: [],
    });
    expect(validateWells("slicer", { field: [] })[0]).toMatch(/at least 1/);
  });

  it("maps bar wells to dimensions then metrics", () => {
    expect(
      wellsToQuery("bar", { axis: ["A.DATE"], legend: ["C.REGION"], values: ["A.REV"] }),
    ).toEqual({ dimensions: ["A.DATE", "C.REGION"], metrics: ["A.REV"] });
  });

  it("puts both scatter axes in metrics", () => {
    expect(
      wellsToQuery("scatter", { x: ["A.REV"], y: ["A.QTY"], detail: ["C.REGION"] }),
    ).toEqual({ dimensions: ["C.REGION"], metrics: ["A.REV", "A.QTY"] });
  });

  it("reports missing and over-full wells", () => {
    expect(validateWells("bar", { axis: [], legend: [], values: ["A.REV"] })[0])
      .toMatch(/Axis/);
    expect(validateWells("pie", { legend: ["C.R"], values: ["A.A", "A.B"] })[0])
      .toMatch(/at most 1/);
    expect(validateWells("table", { dimensions: [], metrics: [] })[0])
      .toMatch(/at least one field/);
  });

  it("refuses the same field in two wells", () => {
    expect(
      validateWells("bar", { axis: ["A.D"], legend: ["A.D"], values: ["A.REV"] })[0],
    ).toMatch(/more than one well/);
  });

  it("builds empty wells for a type", () => {
    expect(emptyWellsFor("pie")).toEqual({ legend: [], values: [] });
  });

  it("routes a clicked field to the first eligible well with room", () => {
    const wells = emptyWellsFor("bar");
    expect(defaultWellFor("bar", "dimension", wells)).toBe("axis");
    expect(defaultWellFor("bar", "metric", wells)).toBe("values");
    const withAxis = { ...wells, axis: ["A.D"] };
    expect(defaultWellFor("bar", "dimension", withAxis)).toBe("legend");
    const full = { axis: ["A.D"], legend: ["A.E"], values: [] };
    expect(defaultWellFor("bar", "dimension", full)).toBeNull();
  });
});
