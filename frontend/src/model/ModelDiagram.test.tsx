import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ModelDiagram from "./ModelDiagram";
import type { SemanticViewDetail } from "../api/types";

const DETAIL: SemanticViewDetail = {
  tables: [{ name: "ORDERS" }, { name: "CUSTOMER" }],
  relationships: [
    {
      name: "ORDER_TO_CUST",
      table: "ORDERS",
      refTable: "CUSTOMER",
      foreignKey: ["O_CUSTKEY"],
      refKey: ["C_CUSTKEY"],
    },
  ],
  dimensions: [
    { table: "ORDERS", name: "STATUS", dataType: "VARCHAR(16777216)" },
    { table: "CUSTOMER", name: "SEGMENT", dataType: "TEXT" },
  ],
  metrics: [{ table: "ORDERS", name: "REVENUE", dataType: "NUMBER(38,2)" }],
  facts: [],
};

function draw(props: Partial<React.ComponentProps<typeof ModelDiagram>> = {}) {
  return render(
    <ModelDiagram
      detail={DETAIL}
      selectedRef={null}
      selectedTable={null}
      onSelectField={() => {}}
      onSelectTable={() => {}}
      {...props}
    />,
  );
}

describe("ModelDiagram", () => {
  it("draws a card per table, naming its fields", () => {
    draw();
    expect(screen.getByText("ORDERS")).toBeInTheDocument();
    expect(screen.getByText("CUSTOMER")).toBeInTheDocument();
    expect(screen.getByText("STATUS")).toBeInTheDocument();
    expect(screen.getByText("SEGMENT")).toBeInTheDocument();
  });

  it("shows the join keys as columns of their own", () => {
    // They are physical columns, not modelled fields, so nothing else in
    // the app would ever mention them -- and they are what the edges are
    // actually drawn on.
    draw();
    expect(screen.getByText("O_CUSTKEY")).toBeInTheDocument();
    expect(screen.getByText("C_CUSTKEY")).toBeInTheDocument();
  });

  it("shortens a type to its family", () => {
    draw();
    expect(screen.getByText("VARCHAR")).toBeInTheDocument();
    expect(screen.queryByText("VARCHAR(16777216)")).not.toBeInTheDocument();
  });

  it("selects a field when its column is clicked", async () => {
    const onSelectField = vi.fn();
    draw({ onSelectField });
    await userEvent.click(screen.getByRole("button", { name: /STATUS/ }));
    expect(onSelectField).toHaveBeenCalledWith("ORDERS.STATUS");
  });

  it("offers no selection on a join key", async () => {
    // A key names a column of the underlying table, so there is no field
    // to select and no query it could go into.
    draw();
    expect(
      screen.queryByRole("button", { name: /O_CUSTKEY/ }),
    ).not.toBeInTheDocument();
  });

  it("selects a table when its header is clicked", async () => {
    const onSelectTable = vi.fn();
    draw({ onSelectTable });
    await userEvent.click(screen.getByRole("button", { name: /ORDERS/ }));
    expect(onSelectTable).toHaveBeenCalledWith("ORDERS");
  });

  it("marks the selected column", () => {
    const { container } = draw({ selectedRef: "ORDERS.STATUS" });
    expect(container.querySelector(".model-column.selected")).toHaveTextContent(
      "STATUS",
    );
  });

  it("defines both cardinality markers, plain and highlighted", () => {
    const { container } = draw();
    for (const id of ["model-many", "model-one", "model-many-on", "model-one-on"]) {
      expect(container.querySelector(`#${id}`), id).toBeInTheDocument();
    }
  });

  it("offers zoom and fit", () => {
    draw();
    for (const name of [/zoom in/i, /zoom out/i, /fit to screen/i]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("says so when a view declares no tables", () => {
    draw({ detail: { ...DETAIL, tables: [], relationships: [] } });
    expect(screen.getByText(/no tables/i)).toBeInTheDocument();
  });

  it("says so when a model declares no joins", () => {
    draw({ detail: { ...DETAIL, relationships: [] } });
    expect(screen.getByText(/no joins/i)).toBeInTheDocument();
  });
});

describe("wide tables", () => {
  const wide: SemanticViewDetail = {
    ...DETAIL,
    dimensions: Array.from({ length: 14 }, (_, i) => ({
      table: "ORDERS",
      name: `D${i}`,
      dataType: "TEXT",
    })),
    metrics: [],
  };

  it("offers to show the fields that did not fit", async () => {
    draw({ detail: wide });
    const more = screen.getByRole("button", { name: /\+8 more/ });
    expect(screen.queryByText("D13")).not.toBeInTheDocument();

    await userEvent.click(more);
    expect(screen.getByText("D13")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show fewer/i })).toBeInTheDocument();
  });
});
