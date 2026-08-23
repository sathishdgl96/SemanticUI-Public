import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Visual } from "../api/types";
import { CATALOG } from "./catalog";
import VisualPicker, { changeVisualType } from "./VisualPicker";

const visual: Visual = {
  id: "v1", type: "bar", title: "",
  layout: { x: 0, y: 0, w: 6, h: 6 },
  wells: { axis: ["C.REGION"], legend: [], values: ["A.REV"] },
  options: { stacked: true },
  filters: [],
};

describe("VisualPicker", () => {
  it("offers every catalog type and marks the current one", async () => {
    const onChange = vi.fn();
    render(<VisualPicker value="bar" onChange={onChange} />);
    expect(screen.getAllByRole("button")).toHaveLength(Object.keys(CATALOG).length);
    expect(screen.getByRole("button", { name: /^column$/i })).toHaveAttribute(
      "aria-pressed", "true",
    );
    await userEvent.click(screen.getByRole("button", { name: /^pie$/i }));
    expect(onChange).toHaveBeenCalledWith("pie");
  });

  it("offers the visuals a PowerBI author looks for", () => {
    render(<VisualPicker value="bar" onChange={vi.fn()} />);
    for (const name of [
      /^column$/i, /^bar$/i, /^line$/i, /^area$/i, /line and column/i,
      /^pie$/i, /^donut$/i, /^treemap$/i, /^funnel$/i, /^gauge$/i,
      /^scatter$/i, /^table$/i, /^matrix$/i, /^card$/i, /multi-row card/i,
      /^slicer$/i,
    ]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });
});

describe("changeVisualType", () => {
  it("carries the fields into the new type's wells by kind", () => {
    // Bar's Axis holds a dimension and Values a metric; pie's wells are named
    // differently (Legend/Values) but want exactly the same two kinds, so
    // nothing should be lost just because the keys disagree.
    const { visual: next, dropped } = changeVisualType(visual, "pie");
    expect(next.type).toBe("pie");
    expect(next.wells.legend).toEqual(["C.REGION"]);
    expect(next.wells.values).toEqual(["A.REV"]);
    expect(dropped).toEqual([]);
  });

  it("keeps every field when switching to a type with roomier wells", () => {
    const wide: Visual = {
      ...visual,
      wells: { axis: ["C.REGION"], legend: ["C.SEGMENT"], values: ["A.REV", "A.COST"] },
    };
    const { visual: next, dropped } = changeVisualType(wide, "table");
    // Table's wells are unbounded, so a switch there can never lose anything.
    expect(next.wells.dimensions).toEqual(["C.REGION", "C.SEGMENT"]);
    expect(next.wells.metrics).toEqual(["A.REV", "A.COST"]);
    expect(dropped).toEqual([]);
  });

  it("fills wells in catalog order so the first field stays first", () => {
    const wide: Visual = {
      ...visual,
      type: "table",
      wells: { dimensions: ["C.REGION", "C.SEGMENT"], metrics: ["A.REV"] },
    };
    const { visual: next } = changeVisualType(wide, "bar");
    expect(next.wells.axis).toEqual(["C.REGION"]);
    expect(next.wells.legend).toEqual(["C.SEGMENT"]);
    expect(next.wells.values).toEqual(["A.REV"]);
  });

  it("names the refs that genuinely had nowhere to go", () => {
    const wide: Visual = {
      ...visual,
      wells: { axis: ["C.REGION"], legend: [], values: ["A.REV", "A.COST"] },
    };
    // A KPI card has one metric well and no dimension well at all.
    const { visual: next, dropped } = changeVisualType(wide, "kpi");
    expect(next.wells.value).toEqual(["A.REV"]);
    expect(dropped).toEqual(["C.REGION", "A.COST"]);
  });

  it("drops options the new type does not understand", () => {
    const { visual: next } = changeVisualType(visual, "line");
    expect(next.options.stacked).toBeUndefined();
  });

  it("keeps everything when the type is unchanged", () => {
    const { visual: next, dropped } = changeVisualType(visual, "bar");
    expect(next.wells).toEqual(visual.wells);
    expect(dropped).toEqual([]);
  });
});
