import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FieldInfo, Visual } from "../api/types";
import DataPane from "./DataPane";

const DIMENSIONS: FieldInfo[] = [
  { table: "CUSTOMERS", name: "REGION", dataType: "TEXT" },
  { table: "ORDERS", name: "ORDER_DATE", dataType: "DATE" },
];
const METRICS: FieldInfo[] = [{ table: "ORDERS", name: "REVENUE", dataType: "NUMBER" }];

function visual(wells: Record<string, string[]>): Visual {
  return {
    id: "v1",
    type: "bar",
    title: "",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells,
    options: {},
    filters: [],
  };
}

const props = {
  dimensions: DIMENSIONS,
  metrics: METRICS,
  selected: null as Visual | null,
  canEdit: true,
  onToggleField: () => {},
  renderRow: (field: FieldInfo) => <span>{`${field.table}.${field.name}`}</span>,
};

describe("DataPane", () => {
  it("groups fields by table, collapsible", async () => {
    render(<DataPane {...props} />);
    expect(screen.getByRole("button", { name: /CUSTOMERS/ })).toBeInTheDocument();
    expect(screen.getByText("ORDERS.REVENUE")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /ORDERS/ }));
    expect(screen.queryByText("ORDERS.REVENUE")).toBeNull();
    expect(screen.getByText("CUSTOMERS.REGION")).toBeInTheDocument();
  });

  it("search narrows the field list", async () => {
    render(<DataPane {...props} />);
    await userEvent.type(screen.getByLabelText(/search fields/i), "reven");
    expect(screen.getByText("ORDERS.REVENUE")).toBeInTheDocument();
    expect(screen.queryByText("CUSTOMERS.REGION")).toBeNull();
  });

  it("says so when nothing matches, rather than showing an empty pane", async () => {
    render(<DataPane {...props} />);
    await userEvent.type(screen.getByLabelText(/search fields/i), "zzz");
    expect(screen.getByText(/no fields match/i)).toBeInTheDocument();
  });

  it("checks exactly the fields present in the selected visual", () => {
    render(
      <DataPane
        {...props}
        selected={visual({ axis: ["CUSTOMERS.REGION"], legend: [], values: [] })}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "CUSTOMERS.REGION" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "ORDERS.REVENUE" })).not.toBeChecked();
  });

  it("reports a check and an uncheck with the field's kind", async () => {
    const onToggleField = vi.fn();
    const { rerender } = render(
      <DataPane {...props} onToggleField={onToggleField} />,
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "ORDERS.REVENUE" }));
    expect(onToggleField).toHaveBeenCalledWith("ORDERS.REVENUE", "metric", true);

    rerender(
      <DataPane
        {...props}
        onToggleField={onToggleField}
        selected={visual({ axis: [], legend: [], values: ["ORDERS.REVENUE"] })}
      />,
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "ORDERS.REVENUE" }));
    expect(onToggleField).toHaveBeenLastCalledWith("ORDERS.REVENUE", "metric", false);
  });

  it("disables the checkboxes for a viewer", () => {
    render(<DataPane {...props} canEdit={false} />);
    expect(screen.getByRole("checkbox", { name: "CUSTOMERS.REGION" })).toBeDisabled();
  });
});
