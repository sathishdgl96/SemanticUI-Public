import { describe, expect, it } from "vitest";
import {
  CATALOG,
  defaultWellFor,
  emptyWellsFor,
  validateWells,
  wellsToQuery,
} from "./catalog";

describe("visual catalog", () => {
  it("contains the core seven", () => {
    expect(Object.keys(CATALOG).sort()).toEqual(
      ["area", "bar", "kpi", "line", "pie", "scatter", "table"],
    );
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
