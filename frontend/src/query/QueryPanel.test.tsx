import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// jsdom has no canvas backend; ECharts' SVG renderer still probes for one
// during init, which spams "Not implemented: HTMLCanvasElement.getContext()"
// warnings. Stub the module so this test exercises the DOM AutoChart
// renders (the title heading + the accessible chart element) rather than
// real chart rendering internals.
vi.mock("echarts", () => ({
  init: vi.fn(() => ({
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  })),
}));

import QueryPanel from "./QueryPanel";

const RESULT = {
  columns: [{ name: "ORDER_DATE", type: "DATE" }, { name: "TOTAL_REVENUE", type: "FIXED" }],
  rows: [["2026-01-01", 10], ["2026-01-02", 20]],
  truncated: false,
  sfqid: "q-1",
  sql: "SELECT 1",
};

const DETAIL = {
  tables: [{ name: "ORDERS" }],
  relationships: [],
  dimensions: [{ table: "ORDERS", name: "ORDER_DATE", dataType: "DATE" }],
  metrics: [{ table: "ORDERS", name: "TOTAL_REVENUE", dataType: "NUMBER(38,2)" }],
  facts: [],
};

const SELECTION = {
  dimensions: ["ORDERS.ORDER_DATE"],
  metrics: ["ORDERS.TOTAL_REVENUE"],
};

describe("QueryPanel", () => {
  it("names a single-series chart with a visible, accessible title", () => {
    render(<QueryPanel result={RESULT} detail={DETAIL} selection={SELECTION} />);

    const heading = screen.getByRole("heading", { name: "TOTAL_REVENUE by ORDER_DATE" });
    expect(heading).toHaveClass("chart-title");

    const chart = screen.getByRole("img", { name: "TOTAL_REVENUE by ORDER_DATE" });
    expect(chart).toBeInTheDocument();
  });
});
