import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ResultsTable from "./ResultsTable";

const RESULT = {
  columns: [{ name: "ORDER_DATE", type: "DATE" }, { name: "TOTAL_REVENUE", type: "FIXED" }],
  rows: [["2026-01-01", 10], ["2026-01-02", 20]],
  truncated: true,
  sfqid: "q-1",
  sql: "SELECT 1",
};

describe("ResultsTable", () => {
  it("renders headers, rows, and the truncated banner", () => {
    render(<ResultsTable result={RESULT} />);
    expect(screen.getByRole("columnheader", { name: "ORDER_DATE" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "2026-01-01" })).toBeInTheDocument();
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });
});
