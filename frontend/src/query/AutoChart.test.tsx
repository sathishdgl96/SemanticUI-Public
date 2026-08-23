import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AutoChart from "./AutoChart";
import type { EChartsOptionLike } from "./renderers/categorical";

/** ECharts renders nothing measurable in jsdom, so what can be asserted is
 *  the wiring: that a click handler is registered, and that the container is
 *  reachable by keyboard.
 *
 *  `vi.mock` rather than `vi.spyOn(echarts, "init")` — an ESM namespace is
 *  not configurable, so spying on the export fails outright. `vi.hoisted`
 *  is what lets the shared handle exist before the hoisted mock factory runs. */
const chart = vi.hoisted(() => ({
  on: (() => {}) as (event: string, fn: (p: { name?: string }) => void) => void,
  handler: undefined as ((p: { name?: string }) => void) | undefined,
}));

vi.mock("echarts", () => ({
  init: () => ({
    setOption: () => {},
    resize: () => {},
    dispose: () => {},
    off: () => {},
    on: (event: string, fn: (p: { name?: string }) => void) => {
      chart.on(event, fn);
      if (event === "click") chart.handler = fn;
    },
  }),
}));

// A minimal but structurally complete CategoricalOptionLike -- itemStyle and
// lineStyle are required by the type, and the whole point of typing the
// fixture is that it stays a real option rather than a lookalike.
const OPTION: EChartsOptionLike = {
  legend: {},
  xAxis: { type: "category", data: ["EAST", "WEST"] },
  yAxis: { type: "value" },
  series: [{ type: "bar", data: [1, 2], itemStyle: {}, lineStyle: {} }],
};

beforeEach(() => {
  chart.on = vi.fn();
  chart.handler = undefined;
});

describe("AutoChart mark clicks", () => {
  it("registers a click handler when onMarkClick is supplied", () => {
    render(<AutoChart kind="bar" title="T" option={OPTION} onMarkClick={vi.fn()} />);
    expect(vi.mocked(chart.on)).toHaveBeenCalledWith("click", expect.any(Function));
  });

  it("passes the clicked category name to the callback", () => {
    const onMarkClick = vi.fn();
    render(<AutoChart kind="bar" title="T" option={OPTION} onMarkClick={onMarkClick} />);
    chart.handler?.({ name: "EAST" });
    expect(onMarkClick).toHaveBeenCalledWith("EAST");
  });

  it("ignores a click that carries no category", () => {
    const onMarkClick = vi.fn();
    render(<AutoChart kind="bar" title="T" option={OPTION} onMarkClick={onMarkClick} />);
    chart.handler?.({ name: "" });
    expect(onMarkClick).not.toHaveBeenCalled();
  });

  it("does not call a callback the chart was rendered without", () => {
    render(<AutoChart kind="bar" title="T" option={OPTION} />);
    // The handler is registered unconditionally; it must be a no-op when the
    // caller supplied nothing, rather than throwing inside ECharts.
    expect(() => chart.handler?.({ name: "EAST" })).not.toThrow();
  });

  it("is focusable and exposed as a button when interactive", () => {
    render(<AutoChart kind="bar" title="Revenue" option={OPTION} onMarkClick={vi.fn()} />);
    expect(screen.getByRole("button", { name: /revenue/i })).toHaveAttribute(
      "tabindex",
      "0",
    );
  });

  it("stays a plain image when it is not interactive", () => {
    render(<AutoChart kind="bar" title="Revenue" option={OPTION} />);
    expect(screen.getByRole("img", { name: /revenue/i })).not.toHaveAttribute("tabindex");
  });

  it("activates the first category on Enter, so the keyboard reaches drill-down", async () => {
    const onMarkClick = vi.fn();
    render(
      <AutoChart
        kind="bar"
        title="T"
        option={OPTION}
        categories={["EAST", "WEST"]}
        onMarkClick={onMarkClick}
      />,
    );
    screen.getByRole("button", { name: "T" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onMarkClick).toHaveBeenCalledWith("EAST");
  });

  it("does nothing on Enter when there are no categories to activate", async () => {
    const onMarkClick = vi.fn();
    render(<AutoChart kind="bar" title="T" option={OPTION} onMarkClick={onMarkClick} />);
    screen.getByRole("button", { name: "T" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onMarkClick).not.toHaveBeenCalled();
  });
});
