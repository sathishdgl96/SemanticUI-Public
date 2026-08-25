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

  // The narrow-pane fix is CSS: the data type carries a shrink factor far
  // above the name's, so it gives up its width first. jsdom has no layout
  // engine and cannot see that. What it CAN hold is the premise the rule
  // depends on -- the name comes first and the type is the trailing <small>
  // -- so a refactor that swaps them, or promotes the type out of <small>,
  // fails here instead of silently restoring the old behavior on screen.
  it("puts the field name before its data type, with the type as the trailing note", () => {
    render(
      <FieldPanel detail={DETAIL} wells={emptyWells()} onAdd={vi.fn()} />,
    );

    const row = screen.getByRole("button", { name: /ORDERS\.TOTAL_REVENUE/ });
    const name = row.querySelector(".field-ref");
    const type = row.querySelector("small");

    expect(name).toHaveTextContent("ORDERS.TOTAL_REVENUE");
    expect(type).toHaveTextContent("NUMBER(38,2)");
    // Node.DOCUMENT_POSITION_FOLLOWING: the type comes after the name.
    expect(name?.compareDocumentPosition(type!)).toBe(4);
  });
});

describe("searching the fields", () => {
  const WIDE = {
    ...DETAIL,
    dimensions: [
      { table: "ORDERS", name: "ORDER_DATE", dataType: "DATE" },
      { table: "CUSTOMERS", name: "REGION", dataType: "TEXT" },
    ],
    metrics: [
      { table: "ORDERS", name: "TOTAL_REVENUE", dataType: "NUMBER(38,2)" },
      { table: "ORDERS", name: "ORDER_COUNT", dataType: "NUMBER" },
    ],
  };

  it("narrows both groups to the fields whose reference contains the text", async () => {
    render(<FieldPanel detail={WIDE} wells={emptyWells()} onAdd={vi.fn()} />);
    await userEvent.type(screen.getByRole("searchbox", { name: /search fields/i }), "rev");

    expect(screen.getByRole("button", { name: /ORDERS\.TOTAL_REVENUE/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ORDER_DATE/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ORDER_COUNT/ })).not.toBeInTheDocument();
    // The group nothing survived in is gone with its rows, not left as a
    // heading over nothing.
    expect(screen.queryByText("Dimensions")).not.toBeInTheDocument();
  });

  it("matches on the table too, so a table's own columns can be found together", async () => {
    render(<FieldPanel detail={WIDE} wells={emptyWells()} onAdd={vi.fn()} />);
    await userEvent.type(screen.getByRole("searchbox"), "customers.");
    expect(screen.getAllByRole("button", { name: /CUSTOMERS\./ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /ORDERS\./ })).not.toBeInTheDocument();
  });

  it("says when nothing matches, and brings everything back when cleared", async () => {
    render(<FieldPanel detail={WIDE} wells={emptyWells()} onAdd={vi.fn()} />);
    const box = screen.getByRole("searchbox");
    await userEvent.type(box, "zzz");
    expect(screen.getByRole("status")).toHaveTextContent(/no fields match/i);
    expect(screen.queryAllByRole("button")).toHaveLength(0);

    await userEvent.clear(box);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });
});

describe("a model's fields", () => {
  const MODEL = {
    tables: [{ name: "Sales 360" }, { name: "sales" }],
    relationships: [],
    dimensions: [
      { table: "Sales 360", name: "Customer", dataType: "TEXT" },
      { table: "sales", name: "PART.BRAND", dataType: "TEXT" },
    ],
    metrics: [
      { table: "sales", name: "CUSTOMERS.CUSTOMER_COUNT", dataType: "NUMBER" },
    ],
    facts: [],
    memberGraphs: [
      {
        alias: "sales",
        tables: [{ name: "CUSTOMERS" }, { name: "PART" }, { name: "LINEITEMS" }],
        relationships: [
          { name: "a", table: "LINEITEMS", refTable: "PART", foreignKey: [], refKey: [] },
          { name: "b", table: "LINEITEMS", refTable: "CUSTOMERS", foreignKey: [], refKey: [] },
        ],
      },
    ],
  };

  it("greys an unreachable pair without being told the source is a model", () => {
    // The rule follows the SHAPE of the describe. It used to follow a
    // compositeId the caller had to pass, and an explore saved before
    // that field existed reopened without it -- so a model quietly fell
    // back to the single-view rule and nothing was ever greyed.
    render(
      <FieldPanel
        detail={MODEL as never}
        wells={{ axis: [], legend: [], values: ["sales.CUSTOMERS.CUSTOMER_COUNT"] }}
        onAdd={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /PART\.BRAND/ })).toBeDisabled();
  });

  it("puts the reason on the field, not in a block above the list", () => {
    render(
      <FieldPanel
        detail={MODEL as never}
        wells={{ axis: [], legend: [], values: ["sales.CUSTOMERS.CUSTOMER_COUNT"] }}
        onAdd={vi.fn()}
      />,
    );
    const row = screen.getByRole("button", { name: /PART\.BRAND/ });
    expect(row).toHaveAttribute("title", expect.stringMatching(/CUSTOMERS/));
    // The prose block is gone: it said the same three lines however many
    // fields shared the reason.
    expect(document.querySelector(".field-blocked")).toBeNull();
  });
});

describe("when the rules cannot run", () => {
  it("says so, rather than quietly greying nothing", async () => {
    // A model whose views reported no joins cannot have its unreachable
    // pairs greyed. Staying silent about that is indistinguishable from
    // a bug, and was taken for one more than once.
    const noJoins = {
      tables: [{ name: "M" }, { name: "sales" }],
      relationships: [],
      dimensions: [{ table: "sales", name: "PART.BRAND", dataType: "TEXT" }],
      metrics: [{ table: "sales", name: "CUSTOMERS.COUNT", dataType: "NUMBER" }],
      facts: [],
      memberGraphs: [
        { alias: "sales", tables: [{ name: "PART" }], relationships: [] },
      ],
    };
    render(
      <FieldPanel
        detail={noJoins as never}
        wells={{ axis: [], legend: [], values: [] }}
        onAdd={vi.fn()}
      />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(/did not report how their tables join/i);
  });

  it("says nothing when they can", async () => {
    const withJoins = {
      tables: [{ name: "M" }, { name: "sales" }],
      relationships: [],
      dimensions: [{ table: "sales", name: "PART.BRAND", dataType: "TEXT" }],
      metrics: [{ table: "sales", name: "CUSTOMERS.COUNT", dataType: "NUMBER" }],
      facts: [],
      memberGraphs: [
        {
          alias: "sales",
          tables: [{ name: "PART" }, { name: "CUSTOMERS" }],
          relationships: [
            { name: "r", table: "PART", refTable: "CUSTOMERS", foreignKey: [], refKey: [] },
          ],
        },
      ],
    };
    render(
      <FieldPanel
        detail={withJoins as never}
        wells={{ axis: [], legend: [], values: [] }}
        onAdd={vi.fn()}
      />,
    );
    expect(screen.queryByRole("note")).toBeNull();
  });
});
