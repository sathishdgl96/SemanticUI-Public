import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FieldInfo, Visual } from "../api/types";
import FormatPane from "./FormatPane";

const FIELDS: FieldInfo[] = [
  { table: "CUSTOMERS", name: "REGION", dataType: "TEXT" },
  { table: "ORDERS", name: "REVENUE", dataType: "NUMBER" },
];

function visual(overrides: Partial<Visual> = {}): Visual {
  return {
    id: "v1",
    type: "bar",
    title: "",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells: {
      axis: ["CUSTOMERS.REGION"],
      legend: [],
      values: ["ORDERS.REVENUE"],
    },
    options: {},
    filters: [],
    ...overrides,
  };
}

function renderPane(v = visual(), onChange = vi.fn()) {
  render(<FormatPane visual={v} onChange={onChange} fields={FIELDS} />);
  return onChange;
}

describe("FormatPane", () => {
  it("defaults to showing the title, legend and gridlines", () => {
    // A report saved before this pane existed must keep the chrome it had.
    renderPane();
    expect(screen.getByLabelText(/show title/i)).toBeChecked();
    expect(screen.getByLabelText(/show legend/i)).toBeChecked();
    expect(screen.getByLabelText(/show gridlines/i)).toBeChecked();
    expect(screen.getByLabelText(/show data labels/i)).not.toBeChecked();
  });

  it("writes a hidden title as an explicit false", () => {
    const onChange = renderPane();
    return userEvent.click(screen.getByLabelText(/show title/i)).then(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ showTitle: false }),
        }),
      );
    });
  });

  it("sets a custom title on the visual itself, not in options", () => {
    const onChange = renderPane();
    return userEvent.type(screen.getByLabelText(/title text/i), "Q").then(() => {
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ title: "Q" }));
    });
  });

  it("disables the legend position when the legend is off", () => {
    renderPane(visual({ options: { showLegend: false } }));
    expect(screen.getByLabelText(/position/i)).toBeDisabled();
  });

  it("offers only fields the visual actually selects as sort options", () => {
    renderPane();
    const select = screen.getByLabelText(/sort by/i) as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    // The query API refuses to order by a column it is not returning.
    expect(values).toEqual(["", "CUSTOMERS.REGION", "ORDERS.REVENUE"]);
  });

  it("names sort fields readably rather than by full reference", () => {
    renderPane();
    const select = screen.getByLabelText(/sort by/i) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toContain("REVENUE");
  });

  it("keeps direction unusable until a sort field is chosen", () => {
    renderPane();
    expect(screen.getByLabelText(/direction/i)).toBeDisabled();
  });

  it("says why Top N needs a sort", () => {
    renderPane();
    expect(screen.getByText(/top n needs a sort/i)).toBeInTheDocument();
  });

  it("records a sort field with a descending default", async () => {
    const onChange = renderPane();
    await userEvent.selectOptions(screen.getByLabelText(/sort by/i), "ORDERS.REVENUE");
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          sort: { field: "ORDERS.REVENUE", direction: "desc" },
        }),
      }),
    );
  });

  it("clears the sort when Default order is chosen", async () => {
    const onChange = renderPane(
      visual({ options: { sort: { field: "ORDERS.REVENUE", direction: "desc" } } }),
    );
    await userEvent.selectOptions(screen.getByLabelText(/sort by/i), "");
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ sort: undefined }) }),
    );
  });

  it("shows a type's own options and hides another type's", () => {
    renderPane();
    // Bar stacks; it has no donut hole.
    expect(screen.getByLabelText(/^stacked$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/100% stacked/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/donut hole/i)).toBeNull();
  });

  it("makes stacked and 100% stacked mutually exclusive", async () => {
    const onChange = renderPane(visual({ options: { stacked: true } }));
    await userEvent.click(screen.getByLabelText(/100% stacked/i));
    // Leaving both on would put a contradiction in the saved document.
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ stacked100: true, stacked: false }),
      }),
    );
  });

  it("offers a number format on a card and no legend controls", () => {
    renderPane(
      visual({ type: "kpi", wells: { value: ["ORDERS.REVENUE"] }, options: {} }),
    );
    expect(screen.getByLabelText(/number format/i)).toBeInTheDocument();
    // A card has no series to tell apart.
    expect(screen.queryByLabelText(/show legend/i)).toBeNull();
  });
});
