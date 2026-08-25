import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { QueryResponse, Visual } from "../api/types";
import type { EChartsOptionLike } from "../query/renderers/categorical";
import ExploreVisual from "./ExploreVisual";

// The chart itself is ECharts on a canvas; what matters here is the option
// the explorer hands it, so the adapter is replaced with something that
// shows that option's axis label settings.
vi.mock("../reports/AutoChartAdapter", () => ({
  default: ({ option }: { option: EChartsOptionLike }) => {
    const axis = option.xAxis as { axisLabel?: { interval?: number; rotate?: number } };
    return (
      <div
        data-testid="chart"
        data-interval={String(axis.axisLabel?.interval)}
        data-rotate={String(axis.axisLabel?.rotate)}
      />
    );
  },
}));

const result: QueryResponse = {
  columns: [
    { name: "REGION", type: "TEXT" },
    { name: "REVENUE", type: "FIXED" },
  ],
  rows: [["EAST", 10], ["WEST", 20]],
  truncated: false,
  sfqid: null,
  sql: "",
};

function visual(options: Record<string, unknown> = {}): Visual {
  return {
    id: "v1",
    type: "bar",
    title: "",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells: { axis: ["C.REGION"], legend: [], values: ["A.REVENUE"] },
    options,
    filters: [],
  };
}

describe("ExploreVisual", () => {
  it("draws every category label, slanted, by default", () => {
    // The explorer has no Format pane, so the chart library's default --
    // dropping any label that would touch its neighbour -- was final: a
    // bar per day named one day in five.
    render(<ExploreVisual visual={visual()} result={result} />);
    const chart = screen.getByTestId("chart");
    expect(chart).toHaveAttribute("data-interval", "0");
    expect(chart).toHaveAttribute("data-rotate", "45");
  });

  it("still honours a visual that says otherwise", () => {
    render(<ExploreVisual visual={visual({ categoryLabels: "auto" })} result={result} />);
    const chart = screen.getByTestId("chart");
    expect(chart).toHaveAttribute("data-interval", "undefined");
    expect(chart).toHaveAttribute("data-rotate", "undefined");
  });
});
