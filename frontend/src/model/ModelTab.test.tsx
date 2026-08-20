import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import ModelTab from "./ModelTab";
import type { SemanticViewDetail } from "../api/types";

const DETAIL: SemanticViewDetail = {
  tables: [{ name: "ORDERS" }, { name: "CUSTOMERS" }],
  relationships: [{ name: "cust_fk", table: "ORDERS", refTable: "CUSTOMERS" }],
  dimensions: [{ table: "ORDERS", name: "STATUS", dataType: "TEXT" }],
  metrics: [],
  facts: [],
};

describe("ModelTab", () => {
  it("waits for the view rather than drawing an empty diagram", () => {
    render(<ModelTab detail={undefined} />);
    expect(screen.getByText(/bind this report to a view/i)).toBeInTheDocument();
  });

  it("shows the diagram and invites a selection", () => {
    render(<ModelTab detail={DETAIL} />);
    expect(screen.getByRole("button", { name: /ORDERS/ })).toBeInTheDocument();
    expect(screen.getByText(/select a table/i)).toBeInTheDocument();
  });

  it("shows a table's fields once it is chosen", async () => {
    render(<ModelTab detail={DETAIL} />);
    await userEvent.click(screen.getByRole("button", { name: /ORDERS/ }));
    expect(screen.getByText("STATUS")).toBeInTheDocument();
  });

  it("clears the selection when the view changes under it", async () => {
    const { rerender } = render(<ModelTab detail={DETAIL} />);
    await userEvent.click(screen.getByRole("button", { name: /ORDERS/ }));
    expect(screen.getByText("STATUS")).toBeInTheDocument();

    rerender(
      <ModelTab
        detail={{
          tables: [{ name: "SALES" }],
          relationships: [],
          dimensions: [{ table: "SALES", name: "CHANNEL", dataType: "TEXT" }],
          metrics: [],
          facts: [],
        }}
      />,
    );
    expect(screen.getByText(/select a table/i)).toBeInTheDocument();
  });
});
