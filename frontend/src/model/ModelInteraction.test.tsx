import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import ModelDiagram from "./ModelDiagram";
import TableDetail from "./TableDetail";
import type { SemanticViewDetail } from "../api/types";

const DETAIL: SemanticViewDetail = {
  tables: [{ name: "ORDERS" }, { name: "CUSTOMERS" }],
  relationships: [
    {
      name: "ORDERS_TO_CUSTOMERS",
      table: "ORDERS",
      refTable: "CUSTOMERS",
      foreignKey: ["O_CUSTKEY"],
      refKey: ["C_CUSTKEY"],
    },
  ],
  dimensions: [{ table: "ORDERS", name: "STATUS", dataType: "TEXT" }],
  metrics: [],
  facts: [],
};

function transform(container: HTMLElement): string {
  return container.querySelector("svg > g")?.getAttribute("transform") ?? "";
}

describe("cardinality notation", () => {
  it("marks many at the foreign key and one at the referenced key", () => {
    // Snowflake declares a foreign key against a referenced key, which is
    // many-to-one by construction. It reports no cardinality of its own,
    // so one-to-one is never claimed.
    const { container } = render(
      <ModelDiagram detail={DETAIL} selected={null} onSelect={() => {}} />,
    );
    const line = container.querySelector("[data-edge] line")!;
    expect(line.getAttribute("marker-start")).toContain("model-many");
    expect(line.getAttribute("marker-end")).toContain("model-one");
  });

  it("defines both markers once", () => {
    const { container } = render(
      <ModelDiagram detail={DETAIL} selected={null} onSelect={() => {}} />,
    );
    expect(container.querySelector("#model-many")).toBeInTheDocument();
    expect(container.querySelector("#model-one")).toBeInTheDocument();
  });
});

describe("viewport controls", () => {
  it("offers zoom, and reports the level", async () => {
    render(<ModelDiagram detail={DETAIL} selected={null} onSelect={() => {}} />);
    expect(screen.getByText("100%")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    expect(screen.getByText("120%")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /zoom out/i }));
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("offers fit to screen", () => {
    render(<ModelDiagram detail={DETAIL} selected={null} onSelect={() => {}} />);
    expect(
      screen.getByRole("button", { name: /fit to screen/i }),
    ).toBeInTheDocument();
  });

  it("zooms on the wheel", () => {
    const { container } = render(
      <ModelDiagram detail={DETAIL} selected={null} onSelect={() => {}} />,
    );
    const before = transform(container);
    fireEvent.wheel(container.querySelector(".model-pane")!, { deltaY: -100 });
    expect(transform(container)).not.toBe(before);
  });
});

describe("panning and dragging", () => {
  it("pans when the background is dragged", () => {
    const { container } = render(
      <ModelDiagram detail={DETAIL} selected={null} onSelect={() => {}} />,
    );
    const pane = container.querySelector(".model-pane")!;
    fireEvent.pointerDown(pane, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(pane, { pointerId: 1, clientX: 40, clientY: 25 });
    expect(transform(container)).toContain("translate(40, 25)");
    fireEvent.pointerUp(pane, { pointerId: 1 });
  });

  it("moves one node without moving the whole diagram", () => {
    const { container } = render(
      <ModelDiagram detail={DETAIL} selected={null} onSelect={() => {}} />,
    );
    const pane = container.querySelector(".model-pane")!;
    const before = transform(container);
    const node = screen.getByRole("button", { name: /ORDERS/ }).closest("g")!;

    fireEvent.pointerDown(node, { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(pane, { pointerId: 2, clientX: 30, clientY: 0 });
    fireEvent.pointerUp(pane, { pointerId: 2 });

    // The node moved; the viewport did not.
    expect(node.getAttribute("transform")).not.toBe("translate(16, 16)");
    expect(transform(container)).toBe(before);
  });

  it("stops dragging when the pointer leaves the pane", () => {
    const { container } = render(
      <ModelDiagram detail={DETAIL} selected={null} onSelect={() => {}} />,
    );
    const pane = container.querySelector(".model-pane")!;
    fireEvent.pointerDown(pane, { button: 0, pointerId: 3, clientX: 0, clientY: 0 });
    fireEvent.pointerLeave(pane);
    const after = transform(container);
    fireEvent.pointerMove(pane, { pointerId: 3, clientX: 90, clientY: 90 });
    expect(transform(container)).toBe(after);
  });
});

describe("join columns", () => {
  it("names the columns a join is on, read outwards from this table", () => {
    render(<TableDetail detail={DETAIL} table="ORDERS" />);
    expect(screen.getByText(/many → one/)).toBeInTheDocument();
    expect(screen.getByText("CUSTOMERS")).toBeInTheDocument();
    expect(screen.getByText("O_CUSTKEY = C_CUSTKEY")).toBeInTheDocument();
  });

  it("reads the other way round from the referenced table", () => {
    render(<TableDetail detail={DETAIL} table="CUSTOMERS" />);
    expect(screen.getByText(/one ← many/)).toBeInTheDocument();
    expect(screen.getByText("C_CUSTKEY = O_CUSTKEY")).toBeInTheDocument();
  });

  it("still lists the join when the key columns are missing", () => {
    const noKeys: SemanticViewDetail = {
      ...DETAIL,
      relationships: [
        { name: "R", table: "ORDERS", refTable: "CUSTOMERS" },
      ],
    };
    render(<TableDetail detail={noKeys} table="ORDERS" />);
    expect(screen.getByText(/many → one/)).toBeInTheDocument();
  });
});
