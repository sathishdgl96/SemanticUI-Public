import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import WellPanel from "./WellPanel";
import { addToWell, emptyWells } from "./wells";

describe("WellPanel", () => {
  it("lists chips per well and removes on click", async () => {
    const wells = addToWell(emptyWells(), "values", "ORDERS.REVENUE", "metric");
    const onRemove = vi.fn();
    render(
      <WellPanel wells={wells} onRemove={onRemove} onRun={vi.fn()} running={false} />,
    );
    expect(screen.getByText("Measures")).toBeInTheDocument();
    expect(screen.getByText("Group by")).toBeInTheDocument();
    expect(screen.getByText("Split by")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /remove ORDERS\.REVENUE/i }),
    );
    expect(onRemove).toHaveBeenCalledWith("values", "ORDERS.REVENUE");
  });

  it("shows an empty hint and disables Run with no fields", () => {
    render(
      <WellPanel wells={emptyWells()} onRemove={vi.fn()} onRun={vi.fn()} running={false} />,
    );
    // Each well says what it wants, rather than three identical hints:
    // "Split by" takes one optional dimension and the others take many.
    expect(screen.getByText(/drop dimensions here/i)).toBeInTheDocument();
    expect(screen.getByText(/optional: one dimension/i)).toBeInTheDocument();
    expect(screen.getByText(/drop measures here/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run/i })).toBeDisabled();
  });
});
