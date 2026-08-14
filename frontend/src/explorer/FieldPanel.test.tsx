import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import FieldPanel from "./FieldPanel";

const DETAIL = {
  tables: [{ name: "ORDERS" }],
  relationships: [],
  dimensions: [{ table: "ORDERS", name: "ORDER_DATE", dataType: "DATE" }],
  metrics: [{ table: "ORDERS", name: "TOTAL_REVENUE", dataType: "NUMBER(38,2)" }],
  facts: [],
};

describe("FieldPanel", () => {
  it("toggles fields and runs", async () => {
    const onToggle = vi.fn();
    const onRun = vi.fn();
    render(
      <FieldPanel
        detail={DETAIL}
        selection={{ dimensions: ["ORDERS.ORDER_DATE"], metrics: [] }}
        onToggle={onToggle}
        onRun={onRun}
        running={false}
      />,
    );
    const dim = screen.getByRole("checkbox", { name: /ORDERS\.ORDER_DATE/ });
    expect(dim).toBeChecked();
    await userEvent.click(
      screen.getByRole("checkbox", { name: /ORDERS\.TOTAL_REVENUE/ }),
    );
    expect(onToggle).toHaveBeenCalledWith("metrics", "ORDERS.TOTAL_REVENUE");
    await userEvent.click(screen.getByRole("button", { name: /run/i }));
    expect(onRun).toHaveBeenCalledOnce();
  });
});
