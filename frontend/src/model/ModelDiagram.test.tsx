import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ModelDiagram from "./ModelDiagram";
import type { SemanticViewDetail } from "../api/types";

const DETAIL: SemanticViewDetail = {
  tables: [{ name: "ORDERS" }, { name: "CUSTOMERS" }],
  relationships: [{ name: "cust_fk", table: "ORDERS", refTable: "CUSTOMERS" }],
  dimensions: [{ table: "ORDERS", name: "STATUS", dataType: "TEXT" }],
  metrics: [{ table: "ORDERS", name: "REVENUE", dataType: "NUMBER" }],
  facts: [],
};

describe("ModelDiagram", () => {
  it("draws every table", () => {
    render(<ModelDiagram detail={DETAIL} selected={null} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /ORDERS/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /CUSTOMERS/ })).toBeInTheDocument();
  });

  it("draws one edge per declared relationship, named", () => {
    const { container } = render(
      <ModelDiagram detail={DETAIL} selected={null} onSelect={() => {}} />,
    );
    expect(container.querySelectorAll("[data-edge]")).toHaveLength(1);
    expect(screen.getByText("cust_fk")).toBeInTheDocument();
  });

  it("selects a table when it is clicked", async () => {
    const onSelect = vi.fn();
    render(<ModelDiagram detail={DETAIL} selected={null} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: /ORDERS/ }));
    expect(onSelect).toHaveBeenCalledWith("ORDERS");
  });

  it("marks the selected table for assistive technology", () => {
    render(<ModelDiagram detail={DETAIL} selected="ORDERS" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /ORDERS/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("says so when the model declares no joins", () => {
    render(
      <ModelDiagram
        detail={{ ...DETAIL, relationships: [] }}
        selected={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/no joins/i)).toBeInTheDocument();
  });

  it("says so when the view has no tables", () => {
    render(
      <ModelDiagram
        detail={{ ...DETAIL, tables: [], relationships: [] }}
        selected={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/no tables/i)).toBeInTheDocument();
  });
});
