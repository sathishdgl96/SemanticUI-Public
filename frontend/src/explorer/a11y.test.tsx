import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import WellPanel from "./WellPanel";
import { addToWell, emptyWells } from "./wells";

describe("wells accessibility", () => {
  it("names every well region and every remove control", () => {
    let wells = addToWell(emptyWells(), "axis", "ORDERS.DATE", "dimension");
    wells = addToWell(wells, "values", "ORDERS.REVENUE", "metric");
    render(
      <WellPanel wells={wells} onRemove={vi.fn()} onRun={vi.fn()} running={false} />,
    );
    expect(screen.getByRole("region", { name: "Group by" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Split by" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Measures" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /remove ORDERS\.DATE/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /remove ORDERS\.REVENUE/i }),
    ).toBeInTheDocument();
  });

  it("marks field kind with a glyph and not with color alone", () => {
    const wells = addToWell(emptyWells(), "values", "ORDERS.REVENUE", "metric");
    render(
      <WellPanel wells={wells} onRemove={vi.fn()} onRun={vi.fn()} running={false} />,
    );
    expect(screen.getByText("Σ")).toBeInTheDocument();
  });
});
