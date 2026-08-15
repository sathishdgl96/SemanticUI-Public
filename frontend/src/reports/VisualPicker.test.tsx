import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Visual } from "../api/types";
import VisualPicker, { changeVisualType } from "./VisualPicker";

const visual: Visual = {
  id: "v1", type: "bar", title: "",
  layout: { x: 0, y: 0, w: 6, h: 6 },
  wells: { axis: ["C.REGION"], legend: [], values: ["A.REV"] },
  options: { stacked: true },
  filters: [],
};

describe("VisualPicker", () => {
  it("offers all seven types and marks the current one", async () => {
    const onChange = vi.fn();
    render(<VisualPicker value="bar" onChange={onChange} />);
    expect(screen.getAllByRole("button")).toHaveLength(7);
    expect(screen.getByRole("button", { name: /bar/i })).toHaveAttribute(
      "aria-pressed", "true",
    );
    await userEvent.click(screen.getByRole("button", { name: /pie/i }));
    expect(onChange).toHaveBeenCalledWith("pie");
  });
});

describe("changeVisualType", () => {
  it("keeps wells the new type still has, and reports the rest", () => {
    const { visual: next, dropped } = changeVisualType(visual, "pie");
    // pie has legend + values; axis does not survive.
    expect(next.type).toBe("pie");
    expect(next.wells.values).toEqual(["A.REV"]);
    expect(next.wells.legend).toEqual([]);
    expect(dropped).toContain("Axis");
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
