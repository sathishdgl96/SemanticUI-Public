import { DndContext } from "@dnd-kit/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useFieldSensors } from "./dndSensors";
import FieldPanel, { type OnAdd } from "./FieldPanel";
import { addToWell, emptyWells } from "./wells";

const DETAIL = {
  tables: [{ name: "ORDERS" }],
  relationships: [],
  dimensions: [{ table: "ORDERS", name: "ORDER_DATE", dataType: "DATE" }],
  metrics: [{ table: "ORDERS", name: "TOTAL_REVENUE", dataType: "NUMBER(38,2)" }],
  facts: [],
};

// A real <DndContext>, wired with the same sensors ExplorerPage uses, so
// this reproduces the actual keyboard behavior a user would hit — not just
// FieldPanel's onClick in isolation (which the standalone tests below
// already exercise without any DndContext at all).
function KeyboardHarness({ onAdd }: { onAdd: OnAdd }) {
  const sensors = useFieldSensors();
  return (
    <DndContext sensors={sensors}>
      <FieldPanel detail={DETAIL} wells={emptyWells()} onAdd={onAdd} />
    </DndContext>
  );
}

describe("FieldPanel", () => {
  it("adds a field to its default well on click", async () => {
    const onAdd = vi.fn();
    const wells = addToWell(emptyWells(), "axis", "ORDERS.ORDER_DATE", "dimension");
    render(<FieldPanel detail={DETAIL} wells={wells} onAdd={onAdd} />);

    // Every clicked dimension goes to the group-by well, however many are
    // already there: an explore groups by as many as you like.
    await userEvent.click(
      screen.getByRole("button", { name: /ORDERS\.ORDER_DATE/ }),
    );
    expect(onAdd).toHaveBeenCalledWith("axis", "ORDERS.ORDER_DATE", "dimension");

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

  it("does not offer a field the selected measure cannot break down", async () => {
    // Snowflake refuses this combination at compile time, and its error names
    // entities rather than fields. Not offering it at all is the difference
    // between a tool that guides and one that lets you find out.
    const JOINED = {
      tables: [{ name: "CUSTOMERS" }, { name: "ORDERS" }],
      relationships: [
        { name: "ORDERS_TO_CUSTOMERS", table: "ORDERS", refTable: "CUSTOMERS" },
      ],
      dimensions: [{ table: "ORDERS", name: "ORDER_DATE", dataType: "DATE" }],
      metrics: [{ table: "CUSTOMERS", name: "CUSTOMER_COUNT", dataType: "NUMBER" }],
      facts: [],
    };
    const onAdd = vi.fn();
    const wells = addToWell(emptyWells(), "values", "CUSTOMERS.CUSTOMER_COUNT", "metric");
    render(<FieldPanel detail={JOINED} wells={wells} onAdd={onAdd} />);

    const row = screen.getByRole("button", { name: /ORDERS\.ORDER_DATE/ });
    expect(row).toBeDisabled();
    // The reason travels with the control, so hovering explains it rather
    // than leaving a dead row with no account of itself.
    expect(row).toHaveAccessibleDescription(/CUSTOMERS\.CUSTOMER_COUNT/);
    await userEvent.click(row);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("adds a field on Enter for keyboard-only users — drag is never the only path", async () => {
    const onAdd = vi.fn();
    render(<KeyboardHarness onAdd={onAdd} />);

    const row = screen.getByRole("button", { name: /ORDERS\.ORDER_DATE/ });
    row.focus();
    // Deliberately a keyboard-only interaction, not userEvent.click(): this
    // is what proves Enter still reaches the row's onClick instead of
    // being swallowed by dnd-kit's KeyboardSensor as a drag pickup.
    await userEvent.keyboard("{Enter}");

    expect(onAdd).toHaveBeenCalledWith("axis", "ORDERS.ORDER_DATE", "dimension");
  });
});
