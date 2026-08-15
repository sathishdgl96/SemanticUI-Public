import { describe, expect, it } from "vitest";
import { chooseChartForWells } from "./chooseChart";

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
