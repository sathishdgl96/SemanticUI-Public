import { describe, expect, it } from "vitest";
import { buildChartOption } from "./buildChartOption";
import { SERIES_COLORS } from "./palette";

const categories = ["2026-01-01", "2026-01-02"];

describe("buildChartOption", () => {
  it("colors series by stable colorIndex", () => {
    const option = buildChartOption("bar", categories, [
      { name: "TOTAL_REVENUE", data: [10, 20], colorIndex: 2 },
    ]);
    expect(option.series[0].itemStyle.color).toBe(SERIES_COLORS[2]);
  });

  it("bar marks are top-rounded; lines are 2px", () => {
    const bar = buildChartOption("bar", categories, [
      { name: "A", data: [1, 2], colorIndex: 0 },
    ]);
    expect(bar.series[0].itemStyle.borderRadius).toEqual([4, 4, 0, 0]);
    const line = buildChartOption("line", categories, [
      { name: "A", data: [1, 2], colorIndex: 0 },
    ]);
    expect(line.series[0].lineStyle.width).toBe(2);
  });

  it("draws every category label, slanted, so a month of days names each day", () => {
    // The chart library's default drops any label that would touch its
    // neighbour. In the explorer there is no Format pane to turn that off,
    // so all-and-slanted is the default here.
    const option = buildChartOption("bar", categories, [
      { name: "A", data: [1, 2], colorIndex: 0 },
    ]);
    expect(option.xAxis.axisLabel.interval).toBe(0);
    expect(option.xAxis.axisLabel.rotate).toBe(45);
  });

  it("gives up more of the plot to longer category names", () => {
    const series = [{ name: "A", data: [1, 2], colorIndex: 0 }];
    const short = buildChartOption("bar", ["Q1", "Q2"], series);
    const long = buildChartOption("bar", ["NORTH AMERICA EAST", "EMEA"], series);
    expect(long.grid.bottom).toBeGreaterThan(short.grid.bottom);
    // ...but never the whole chart: past a cap the label is truncated instead.
    const absurd = buildChartOption("bar", ["X".repeat(200)], series);
    expect(absurd.grid.bottom).toBeLessThanOrEqual(long.grid.bottom + 96);
    expect(absurd.xAxis.axisLabel.overflow).toBe("truncate");
  });

  it("legend only for 2+ series", () => {
    const one = buildChartOption("bar", categories, [
      { name: "A", data: [1, 2], colorIndex: 0 },
    ]);
    expect(one.legend.show).toBe(false);
    const two = buildChartOption("bar", categories, [
      { name: "A", data: [1, 2], colorIndex: 0 },
      { name: "B", data: [3, 4], colorIndex: 1 },
    ]);
    expect(two.legend.show).toBe(true);
  });
});
