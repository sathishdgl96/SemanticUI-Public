import { describe, expect, it } from "vitest";
import type { ReportDefinition, Visual } from "../api/types";
import { normalizeDefinition } from "./normalize";

const visual: Visual = {
  id: "v1",
  type: "bar",
  title: "",
  layout: { x: 0, y: 0, w: 6, h: 6 },
  wells: { axis: ["C.REGION"], legend: [], values: ["A.REV"] },
  options: {},
  filters: [],
};

const base = {
  schemaVersion: 2,
  name: "R",
  view: { database: "D", schema: "S", name: "V" },
  canvas: { columns: 12, rowHeight: 40 },
  hierarchies: [],
};

describe("normalizeDefinition", () => {
  it("wraps a pre-pages document's visuals into one page", () => {
    // The exact shape an older server serves. Reading `.pages.find` on this
    // threw and unmounted the builder, so the user got a blank screen.
    const legacy = {
      ...base,
      visuals: [visual],
      filters: [{ id: "f1", field: "C.REGION", op: "is" as const, values: ["EAST"] }],
    } as unknown as ReportDefinition;

    const out = normalizeDefinition(legacy);
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0].name).toBe("Page 1");
    expect(out.pages[0].visuals).toEqual([visual]);
    // Those filters were the page scope before pages existed.
    expect(out.pages[0].filters[0].field).toBe("C.REGION");
    expect(out.filters).toEqual([]);
    expect("visuals" in out).toBe(false);
  });

  it("leaves a current document alone", () => {
    const current: ReportDefinition = {
      ...base,
      schemaVersion: 3,
      pages: [{ id: "p1", name: "Page 1", visuals: [visual], filters: [] }],
      filters: [],
    };
    expect(normalizeDefinition(current)).toEqual(current);
  });

  it("fills in a page missing its own collections", () => {
    const partial = {
      ...base,
      schemaVersion: 3,
      pages: [{ id: "p1", name: "Page 1" }],
      filters: [],
    } as unknown as ReportDefinition;
    const out = normalizeDefinition(partial);
    expect(out.pages[0].visuals).toEqual([]);
    expect(out.pages[0].filters).toEqual([]);
  });

  it("gives a document with neither pages nor visuals one empty page", () => {
    const empty = { ...base } as unknown as ReportDefinition;
    const out = normalizeDefinition(empty);
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0].visuals).toEqual([]);
  });
});
