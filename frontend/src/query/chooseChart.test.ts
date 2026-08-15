import { describe, expect, it } from "vitest";
import { chooseChart, chooseChartForWells } from "./chooseChart";

describe("chooseChart", () => {
  it("bar for 1 dimension + metrics", () => {
    expect(chooseChart(1, 1, "TEXT")).toBe("bar");
    expect(chooseChart(1, 3, "FIXED")).toBe("bar");
  });
  it("line when the dimension is date-like", () => {
    expect(chooseChart(1, 1, "DATE")).toBe("line");
    expect(chooseChart(1, 2, "TIMESTAMP_NTZ")).toBe("line");
  });
  it("none for 0 or 2+ dimensions or no metrics", () => {
    expect(chooseChart(0, 2)).toBe("none");
    expect(chooseChart(2, 1, "TEXT")).toBe("none");
    expect(chooseChart(1, 0, "TEXT")).toBe("none");
  });
});

describe("chooseChartForWells", () => {
  it("bar/line for axis + values", () => {
    expect(chooseChartForWells(1, 0, 2, "TEXT")).toBe("bar");
    expect(chooseChartForWells(1, 0, 1, "DATE")).toBe("line");
  });
  it("charts axis + legend + one metric", () => {
    expect(chooseChartForWells(1, 1, 1, "TEXT")).toBe("bar");
    expect(chooseChartForWells(1, 1, 1, "TIMESTAMP_NTZ")).toBe("line");
  });
  it("none without an axis or without metrics", () => {
    expect(chooseChartForWells(0, 1, 1, "TEXT")).toBe("none");
    expect(chooseChartForWells(1, 0, 0, "TEXT")).toBe("none");
  });
});
