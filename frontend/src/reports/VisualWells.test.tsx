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
    expect(screen.getAllByText(/add data fields here/i).length).toBe(3);
  });
});

describe("ad-hoc aggregation", () => {
  const withFact = (options = {}): Visual => ({
    id: "v1",
    type: "bar",
    title: "",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells: { axis: ["C.REGION"], legend: [], values: ["O.QUANTITY", "O.REVENUE"] },
    options,
    filters: [],
  });

  it("offers an aggregation on a raw fact but not on a governed metric", () => {
    render(
      <DndContext>
        <VisualWells visual={withFact()} onChange={() => {}} factRefs={["O.QUANTITY"]} />
      </DndContext>,
    );
    // The view's own metric already knows how it is measured; offering a
    // choice there would imply it could be overridden.
    expect(
      screen.getByLabelText("Aggregation for O.QUANTITY"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Aggregation for O.REVENUE")).toBeNull();
  });

  it("defaults a fresh fact to Sum", () => {
    render(
      <DndContext>
        <VisualWells visual={withFact()} onChange={() => {}} factRefs={["O.QUANTITY"]} />
      </DndContext>,
    );
    expect(screen.getByLabelText("Aggregation for O.QUANTITY")).toHaveValue("sum");
  });

  it("records a chosen function against the field", async () => {
    const onChange = vi.fn();
    render(
      <DndContext>
        <VisualWells visual={withFact()} onChange={onChange} factRefs={["O.QUANTITY"]} />
      </DndContext>,
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Aggregation for O.QUANTITY"),
      "avg",
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ aggregations: { "O.QUANTITY": "avg" } }),
      }),
    );
  });

  it("drops the aggregation when the field leaves the well", async () => {
    const onChange = vi.fn();
    render(
      <DndContext>
        <VisualWells
          visual={withFact({ aggregations: { "O.QUANTITY": "avg" } })}
          onChange={onChange}
          factRefs={["O.QUANTITY"]}
        />
      </DndContext>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove O.QUANTITY" }));
    const next = onChange.mock.calls.at(-1)![0];
    // A setting left behind for a field the visual no longer holds would
    // quietly come back if the field did.
    expect(next.options.aggregations).toEqual({});
    expect(next.wells.values).toEqual(["O.REVENUE"]);
  });
});
