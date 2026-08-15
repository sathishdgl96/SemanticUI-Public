import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import FieldPanel from "./FieldPanel";
import { addToWell, emptyWells } from "./wells";

const DETAIL = {
  tables: [{ name: "ORDERS" }],
  relationships: [],
  dimensions: [{ table: "ORDERS", name: "ORDER_DATE", dataType: "DATE" }],
  metrics: [{ table: "ORDERS", name: "TOTAL_REVENUE", dataType: "NUMBER(38,2)" }],
  facts: [],
};

describe("FieldPanel", () => {
  it("adds a field to its default well on click", async () => {
    const onAdd = vi.fn();
    const wells = addToWell(emptyWells(), "axis", "ORDERS.ORDER_DATE", "dimension");
    render(<FieldPanel detail={DETAIL} wells={wells} onAdd={onAdd} />);

    // Axis is already occupied, so a second dimension defaults to legend.
    await userEvent.click(
      screen.getByRole("button", { name: /ORDERS\.ORDER_DATE/ }),
    );
    expect(onAdd).toHaveBeenCalledWith("legend", "ORDERS.ORDER_DATE", "dimension");

    await userEvent.click(
      screen.getByRole("button", { name: /ORDERS\.TOTAL_REVENUE/ }),
    );
    expect(onAdd).toHaveBeenCalledWith("values", "ORDERS.TOTAL_REVENUE", "metric");
  });

  it("routes a dimension to axis by default when axis is empty", async () => {
    const onAdd = vi.fn();
    render(<FieldPanel detail={DETAIL} wells={emptyWells()} onAdd={onAdd} />);

    await userEvent.click(
      screen.getByRole("button", { name: /ORDERS\.ORDER_DATE/ }),
    );
    expect(onAdd).toHaveBeenCalledWith("axis", "ORDERS.ORDER_DATE", "dimension");
  });
});
