import { DndContext } from "@dnd-kit/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Visual } from "../api/types";
import VisualWells from "./VisualWells";

function renderWells(visual: Visual, onChange = vi.fn()) {
  render(
    <DndContext>
      <VisualWells visual={visual} onChange={onChange} />
    </DndContext>,
  );
  return onChange;
}

const bar: Visual = {
  id: "v1", type: "bar", title: "",
  layout: { x: 0, y: 0, w: 6, h: 6 },
  wells: { axis: ["C.REGION"], legend: [], values: ["A.REV"] },
  options: {},
  filters: [],
};

describe("VisualWells", () => {
  it("renders the wells its type declares, each as a named region", () => {
    renderWells(bar);
    expect(screen.getByRole("region", { name: "Axis" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Legend" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Values" })).toBeInTheDocument();
  });

  it("renders a different well set for a different type", () => {
    renderWells({ ...bar, type: "scatter", wells: { x: [], y: [], detail: [] } });
    expect(screen.getByRole("region", { name: "X axis" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Y axis" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Axis" })).not.toBeInTheDocument();
  });

  it("removes a field through its own button", async () => {
    const onChange = renderWells(bar);
    await userEvent.click(screen.getByRole("button", { name: /remove C\.REGION/i }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ wells: expect.objectContaining({ axis: [] }) }),
    );
  });

  it("states what each empty well accepts", () => {
    renderWells({ ...bar, wells: { axis: [], legend: [], values: [] } });
    expect(screen.getAllByText(/drop a field here/i).length).toBe(3);
  });
});
