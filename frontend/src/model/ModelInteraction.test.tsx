import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import ModelTab from "./ModelTab";
import TableDetail from "./TableDetail";
import type { SemanticViewDetail } from "../api/types";

/** LINEITEM -> ORDERS -> CUSTOMER, and a PART that only LINEITEM reaches. */
const DETAIL: SemanticViewDetail = {
  tables: [
    { name: "LINEITEM" },
    { name: "ORDERS" },
    { name: "CUSTOMER" },
    { name: "PART" },
  ],
  relationships: [
    {
      name: "LINE_TO_ORDER",
      table: "LINEITEM",
      refTable: "ORDERS",
      foreignKey: ["L_ORDERKEY"],
      refKey: ["O_ORDERKEY"],
    },
    {
      name: "LINE_TO_PART",
      table: "LINEITEM",
      refTable: "PART",
      foreignKey: ["L_PARTKEY"],
      refKey: ["P_PARTKEY"],
    },
    {
      name: "ORDER_TO_CUST",
      table: "ORDERS",
      refTable: "CUSTOMER",
      foreignKey: ["O_CUSTKEY"],
      refKey: ["C_CUSTKEY"],
    },
  ],
  dimensions: [
    { table: "ORDERS", name: "STATUS", dataType: "TEXT" },
    { table: "CUSTOMER", name: "SEGMENT", dataType: "TEXT" },
    { table: "PART", name: "BRAND", dataType: "TEXT" },
  ],
  metrics: [
    { table: "ORDERS", name: "ORDER_TOTAL", dataType: "NUMBER" },
    { table: "LINEITEM", name: "LINE_REVENUE", dataType: "NUMBER" },
  ],
  facts: [],
};

function panel(): HTMLElement {
  return document.querySelector(".model-detail") as HTMLElement;
}

async function clickColumn(name: RegExp | string) {
  const card = document.querySelector(".model-pane") as HTMLElement;
  await userEvent.click(within(card).getByRole("button", { name }));
}

describe("clicking a column", () => {
  it("names the field and the table it lives in", async () => {
    render(<ModelTab detail={DETAIL} />);
    await clickColumn(/STATUS/);
    expect(within(panel()).getByRole("heading", { level: 3 })).toHaveTextContent(
      "ORDERSSTATUS",
    );
  });

  it("says how far away each other table is, and on which columns", async () => {
    render(<ModelTab detail={DETAIL} />);
    await clickColumn(/STATUS/);
    // CUSTOMER one way, LINEITEM the other.
    expect(within(panel()).getAllByText(/1 join away/)).toHaveLength(2);
    expect(within(panel()).getByText("O_CUSTKEY = C_CUSTKEY")).toBeInTheDocument();
  });

  it("distinguishes the direction a join is read in", async () => {
    render(<ModelTab detail={DETAIL} />);
    await clickColumn(/STATUS/);
    // ORDERS references CUSTOMER; LINEITEM references ORDERS.
    expect(
      within(panel()).getByText(/1 join away — this table references it/),
    ).toBeInTheDocument();
    expect(
      within(panel()).getByText(/1 join away — it references this table/),
    ).toBeInTheDocument();
  });

  it("names the entity that bridges a table neither end reaches", async () => {
    render(<ModelTab detail={DETAIL} />);
    await clickColumn(/STATUS/);
    expect(
      within(panel()).getByText(/Only joined through LINEITEM/),
    ).toBeInTheDocument();
  });

  it("says which fields cannot be asked alongside it, and why", async () => {
    render(<ModelTab detail={DETAIL} />);
    await clickColumn(/BRAND/);
    expect(
      within(panel()).getByText("Measured per ORDERS — cannot break down by PART."),
    ).toBeInTheDocument();
    expect(within(panel()).getByText(/1 cannot be asked alongside it/)).toBeInTheDocument();
  });

  it("counts what the field does reach", async () => {
    render(<ModelTab detail={DETAIL} />);
    await clickColumn(/STATUS/);
    // Every other field: SEGMENT, BRAND, ORDER_TOTAL, LINE_REVENUE. A
    // dimension blocks nothing, so all four.
    expect(within(panel()).getByText(/Reaches 4 of 4 other fields/)).toBeInTheDocument();
  });

  it("walks to another field from the panel", async () => {
    render(<ModelTab detail={DETAIL} />);
    await clickColumn(/STATUS/);
    await userEvent.click(within(panel()).getByRole("button", { name: /SEGMENT/ }));
    expect(within(panel()).getByRole("heading", { level: 3 })).toHaveTextContent(
      "CUSTOMERSEGMENT",
    );
  });

  it("clears back to the invitation", async () => {
    render(<ModelTab detail={DETAIL} />);
    await clickColumn(/STATUS/);
    await userEvent.click(within(panel()).getByRole("button", { name: /clear/i }));
    expect(screen.getByText(/select a table/i)).toBeInTheDocument();
  });

  it("opens the relations of a field chosen from the table panel", async () => {
    render(<ModelTab detail={DETAIL} />);
    const card = document.querySelector(".model-pane") as HTMLElement;
    await userEvent.click(within(card).getByRole("button", { name: /^ORDERS/ }));
    await userEvent.click(within(panel()).getByRole("button", { name: /STATUS/ }));
    expect(within(panel()).getByText(/Reaches 4 of 4 other fields/)).toBeInTheDocument();
  });
});

describe("join columns", () => {
  it("names the columns a join is on, read outwards from this table", () => {
    render(<TableDetail detail={DETAIL} table="ORDERS" />);
    expect(screen.getByText(/many → one/)).toBeInTheDocument();
    expect(screen.getByText("O_CUSTKEY = C_CUSTKEY")).toBeInTheDocument();
  });

  it("reads the other way round from the referenced table", () => {
    render(<TableDetail detail={DETAIL} table="CUSTOMER" />);
    expect(screen.getByText(/one ← many/)).toBeInTheDocument();
    expect(screen.getByText("C_CUSTKEY = O_CUSTKEY")).toBeInTheDocument();
  });

  it("still lists the join when the key columns are missing", () => {
    const noKeys: SemanticViewDetail = {
      ...DETAIL,
      relationships: [{ name: "R", table: "ORDERS", refTable: "CUSTOMER" }],
    };
    render(<TableDetail detail={noKeys} table="ORDERS" />);
    expect(screen.getByText(/many → one/)).toBeInTheDocument();
  });
});
