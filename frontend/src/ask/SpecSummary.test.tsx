import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AskSpec } from "../api/types";
import SpecSummary from "./SpecSummary";

const SPEC: AskSpec = {
  dimensions: ["CUSTOMERS.REGION"],
  metrics: ["ORDERS.TOTAL_REVENUE"],
  filters: [
    {
      id: "q1",
      field: "ORDERS.ORDER_DATE",
      op: "relativeDate",
      unit: "month",
      count: 3,
    },
  ],
  orderBy: [],
  limit: 20,
  explanation: "Revenue by region.",
};

describe("SpecSummary", () => {
  it("names the fields the model actually asked for", () => {
    render(<SpecSummary spec={SPEC} />);
    expect(screen.getByText(/CUSTOMERS.REGION/)).toBeInTheDocument();
    expect(screen.getByText(/ORDERS.TOTAL_REVENUE/)).toBeInTheDocument();
  });

  it("describes the filters in words rather than as JSON", () => {
    render(<SpecSummary spec={SPEC} />);
    expect(screen.getByText(/in the last 3 months/i)).toBeInTheDocument();
  });

  it("says so when there were no filters, rather than showing nothing", () => {
    // A blank row reads as "unknown"; "No filters" reads as "unfiltered".
    render(<SpecSummary spec={{ ...SPEC, filters: [] }} />);
    expect(screen.getByText(/no filters/i)).toBeInTheDocument();
  });

  it("omits the grouping row entirely when nothing was grouped", () => {
    render(<SpecSummary spec={{ ...SPEC, dimensions: [] }} />);
    expect(screen.queryByText(/grouped by/i)).toBeNull();
  });

  it("says so when nothing was measured", () => {
    render(<SpecSummary spec={{ ...SPEC, metrics: [] }} />);
    expect(screen.getByText("nothing")).toBeInTheDocument();
  });
});
