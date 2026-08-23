import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import TableDetail from "./TableDetail";
import type { SemanticViewDetail } from "../api/types";

const DETAIL: SemanticViewDetail = {
  tables: [{ name: "ORDERS" }, { name: "CUSTOMERS" }],
  relationships: [],
  dimensions: [
    { table: "ORDERS", name: "STATUS", dataType: "TEXT" },
    { table: "CUSTOMERS", name: "REGION", dataType: "TEXT" },
  ],
  metrics: [{ table: "ORDERS", name: "REVENUE", dataType: "NUMBER" }],
  facts: [{ table: "ORDERS", name: "AMOUNT", dataType: "NUMBER" }],
};

describe("TableDetail", () => {
  it("invites a selection when nothing is chosen", () => {
    render(<TableDetail detail={DETAIL} table={null} />);
    expect(screen.getByText(/select a table/i)).toBeInTheDocument();
  });

  it("shows only the chosen table's fields, grouped by kind", () => {
    render(<TableDetail detail={DETAIL} table="ORDERS" />);
    expect(screen.getByText("STATUS")).toBeInTheDocument();
    expect(screen.getByText("REVENUE")).toBeInTheDocument();
    expect(screen.getByText("AMOUNT")).toBeInTheDocument();
    expect(screen.queryByText("REGION")).not.toBeInTheDocument();
  });

  it("names each group", () => {
    render(<TableDetail detail={DETAIL} table="ORDERS" />);
    expect(screen.getByText(/dimensions/i)).toBeInTheDocument();
    expect(screen.getByText(/metrics/i)).toBeInTheDocument();
    expect(screen.getByText(/facts/i)).toBeInTheDocument();
  });

  it("shows each field's data type", () => {
    render(<TableDetail detail={DETAIL} table="ORDERS" />);
    expect(screen.getAllByText("NUMBER").length).toBeGreaterThan(0);
  });

  it("omits a group the table has nothing in", () => {
    render(<TableDetail detail={DETAIL} table="CUSTOMERS" />);
    expect(screen.getByText(/dimensions/i)).toBeInTheDocument();
    expect(screen.queryByText(/metrics/i)).not.toBeInTheDocument();
  });

  it("says so for a table with no fields at all", () => {
    render(
      <TableDetail
        detail={{ ...DETAIL, dimensions: [], metrics: [], facts: [] }}
        table="ORDERS"
      />,
    );
    expect(screen.getByText(/no fields/i)).toBeInTheDocument();
  });
});
