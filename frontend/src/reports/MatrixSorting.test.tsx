import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import MatrixTable from "./MatrixTable";
import type { QueryResponse, Visual } from "../api/types";

const RESULT: QueryResponse = {
  columns: [
    { name: "REGION", type: "TEXT" },
    { name: "COUNTRY", type: "TEXT" },
    { name: "REVENUE", type: "NUMBER" },
  ],
  rows: [
    ["EUROPE", "FRANCE", 10],
    ["EUROPE", "GERMANY", 20],
    ["ASIA", "INDIA", 5],
    ["ASIA", "JAPAN", 90],
  ],
  truncated: false,
  sql: "",
  sfqid: null,
};

const VISUAL = {
  id: "v1",
  type: "matrix",
  wells: { rows: ["C.REGION", "C.COUNTRY"], values: ["O.REVENUE"] },
  options: {},
} as unknown as Visual;

function rowLabels(): string[] {
  // The body only: the header rows carry column names and the footer
  // carries the grand total, neither of which the sort reorders.
  const body = screen.getByRole("table").querySelector("tbody") as HTMLElement;
  return within(body)
    .getAllByRole("row")
    .map((row) => within(row).getAllByRole("rowheader")[0]?.textContent ?? "")
    .map((text) => text.replace(/^[+−]\s*/, "").trim())
    .filter(Boolean);
}

describe("matrix sorting", () => {
  it("starts in the order the query returned", () => {
    render(<MatrixTable visual={VISUAL} result={RESULT} />);
    expect(rowLabels()).toEqual([
      "EUROPE", "FRANCE", "GERMANY", "ASIA", "INDIA", "JAPAN",
    ]);
  });

  it("sorts groups by measure while keeping children under their parent", async () => {
    render(<MatrixTable visual={VISUAL} result={RESULT} />);
    await userEvent.click(screen.getByRole("button", { name: /REVENUE/i }));
    // Ascending by subtotal: EUROPE 30 then ASIA 95, each with its own
    // countries still beneath it and also sorted.
    expect(rowLabels()).toEqual([
      "EUROPE", "FRANCE", "GERMANY", "ASIA", "INDIA", "JAPAN",
    ]);
    await userEvent.click(screen.getByRole("button", { name: /REVENUE/i }));
    expect(rowLabels()).toEqual([
      "ASIA", "JAPAN", "INDIA", "EUROPE", "GERMANY", "FRANCE",
    ]);
  });

  it("returns to the query order on the third click", async () => {
    render(<MatrixTable visual={VISUAL} result={RESULT} />);
    const header = screen.getByRole("button", { name: /REVENUE/i });
    await userEvent.click(header);
    await userEvent.click(header);
    await userEvent.click(header);
    expect(rowLabels()).toEqual([
      "EUROPE", "FRANCE", "GERMANY", "ASIA", "INDIA", "JAPAN",
    ]);
  });

  it("sorts by the row labels when their header is clicked", async () => {
    render(<MatrixTable visual={VISUAL} result={RESULT} />);
    await userEvent.click(screen.getByRole("button", { name: /REGION/i }));
    expect(rowLabels()).toEqual([
      "ASIA", "INDIA", "JAPAN", "EUROPE", "FRANCE", "GERMANY",
    ]);
  });

  it("announces the sort direction to assistive technology", async () => {
    render(<MatrixTable visual={VISUAL} result={RESULT} />);
    await userEvent.click(screen.getByRole("button", { name: /REVENUE/i }));
    expect(
      screen.getByRole("columnheader", { name: /REVENUE/i }),
    ).toHaveAttribute("aria-sort", "ascending");
  });
});
