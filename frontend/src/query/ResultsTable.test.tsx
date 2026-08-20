import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import ResultsTable from "./ResultsTable";

const RESULT = {
  columns: [
    { name: "REGION", type: "TEXT" },
    { name: "REVENUE", type: "NUMBER" },
  ],
  rows: [
    ["EUROPE", 30],
    ["ASIA", 13],
    ["AFRICA", 200],
  ] as unknown[][],
  truncated: false,
};

function bodyColumn(index: number): string[] {
  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  return rows.map((row) => within(row).getAllByRole("cell")[index].textContent ?? "");
}

describe("ResultsTable sorting", () => {
  it("starts in the order the query returned", () => {
    render(<ResultsTable result={RESULT} />);
    expect(bodyColumn(0)).toEqual(["EUROPE", "ASIA", "AFRICA"]);
  });

  it("sorts a numeric column by value on the first click", async () => {
    render(<ResultsTable result={RESULT} />);
    await userEvent.click(screen.getByRole("button", { name: /revenue/i }));
    expect(bodyColumn(1)).toEqual(["13", "30", "200"]);
  });

  it("reverses on the second click and restores on the third", async () => {
    render(<ResultsTable result={RESULT} />);
    const header = screen.getByRole("button", { name: /revenue/i });
    await userEvent.click(header);
    await userEvent.click(header);
    expect(bodyColumn(1)).toEqual(["200", "30", "13"]);
    await userEvent.click(header);
    expect(bodyColumn(0)).toEqual(["EUROPE", "ASIA", "AFRICA"]);
  });

  it("tells assistive technology which way the column is sorted", async () => {
    render(<ResultsTable result={RESULT} />);
    const revenue = screen.getByRole("columnheader", { name: /revenue/i });
    expect(revenue).toHaveAttribute("aria-sort", "none");
    await userEvent.click(screen.getByRole("button", { name: /revenue/i }));
    expect(revenue).toHaveAttribute("aria-sort", "ascending");
  });

  it("sorts only the column that was clicked", async () => {
    render(<ResultsTable result={RESULT} />);
    await userEvent.click(screen.getByRole("button", { name: /region/i }));
    expect(bodyColumn(0)).toEqual(["AFRICA", "ASIA", "EUROPE"]);
    await userEvent.click(screen.getByRole("button", { name: /revenue/i }));
    expect(bodyColumn(1)).toEqual(["13", "30", "200"]);
    expect(
      screen.getByRole("columnheader", { name: /region/i }),
    ).toHaveAttribute("aria-sort", "none");
  });

  it("still shows the truncation banner", () => {
    render(<ResultsTable result={{ ...RESULT, truncated: true }} />);
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });
});
