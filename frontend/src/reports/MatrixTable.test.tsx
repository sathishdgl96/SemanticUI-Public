import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { QueryResponse, Visual } from "../api/types";
import MatrixTable from "./MatrixTable";

function visual(overrides: Partial<Visual> = {}): Visual {
  return {
    id: "v1",
    type: "matrix",
    title: "",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells: {
      rows: ["C.REGION", "C.SEGMENT"],
      columns: [],
      values: ["O.REVENUE"],
    },
    options: {},
    filters: [],
    ...overrides,
  };
}

const nested: QueryResponse = {
  columns: [{ name: "REGION", type: "TEXT" }, { name: "SEGMENT", type: "TEXT" }, { name: "REVENUE", type: "TEXT" }],
  rows: [
    ["EAST", "RETAIL", 10],
    ["EAST", "WHOLESALE", 5],
    ["WEST", "RETAIL", 20],
  ],
  truncated: false,
  sfqid: null,
  sql: "",
};

describe("MatrixTable", () => {
  it("nests row groups and puts the subtotal on the group row", () => {
    render(<MatrixTable visual={visual()} result={nested} />);
    // EAST is a group row carrying 10 + 5.
    const east = screen.getByRole("row", { name: /EAST/ });
    expect(east.textContent).toContain("15");
    // Grand total row.
    const total = screen.getByRole("row", { name: /^Total/ });
    expect(total.textContent).toContain("35");
  });

  it("collapses a group without losing its subtotal", async () => {
    render(<MatrixTable visual={visual()} result={nested} />);
    expect(screen.getAllByText("RETAIL")).toHaveLength(2);
    await userEvent.click(
      screen.getByRole("button", { name: /Collapse EAST/ }),
    );
    // EAST's children are gone; WEST's RETAIL remains; EAST still shows 15.
    expect(screen.getAllByText("RETAIL")).toHaveLength(1);
    expect(screen.getByRole("row", { name: /EAST/ }).textContent).toContain("15");
  });

  it("adds a row Total column when a column grouping is on", () => {
    const withColumns = visual({
      wells: { rows: ["C.REGION"], columns: ["O.YEAR"], values: ["O.REVENUE"] },
    });
    const result: QueryResponse = {
      columns: [{ name: "REGION", type: "TEXT" }, { name: "YEAR", type: "TEXT" }, { name: "REVENUE", type: "TEXT" }],
      rows: [
        ["EAST", "2024", 10],
        ["EAST", "2025", 5],
        ["WEST", "2024", 20],
      ],
      truncated: false,
      sfqid: null,
      sql: "",
    };
    render(<MatrixTable visual={withColumns} result={result} />);
    const east = screen.getByRole("row", { name: /EAST/ });
    // 2024 cell, 2025 cell, then the row total.
    expect(east.textContent).toContain("15");
    expect(screen.getByRole("columnheader", { name: "Total" })).toBeInTheDocument();
  });

  it("collapses and expands the whole hierarchy from the toolbar", async () => {
    render(<MatrixTable visual={visual()} result={nested} />);
    expect(screen.getAllByText("RETAIL")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByText("RETAIL")).toBeNull();
    // The group rows keep their subtotals while collapsed.
    expect(screen.getByRole("row", { name: /EAST/ }).textContent).toContain("15");

    await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getAllByText("RETAIL")).toHaveLength(2);
  });

  it("offers no hierarchy toolbar on a flat matrix", () => {
    const flat = visual({
      wells: { rows: ["C.REGION"], columns: [], values: ["O.REVENUE"] },
    });
    render(<MatrixTable visual={flat} result={nested} />);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("hides every total when subtotals are switched off", () => {
    render(
      <MatrixTable
        visual={visual({ options: { subtotals: false } })}
        result={nested}
      />,
    );
    expect(screen.queryByRole("row", { name: /^Total/ })).not.toBeInTheDocument();
  });
});
