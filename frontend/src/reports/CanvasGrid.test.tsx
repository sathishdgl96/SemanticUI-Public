import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./VisualTile", () => ({
  default: ({ visual }: { visual: { id: string } }) => (
    <div data-testid={`tile-${visual.id}`}>{visual.id}</div>
  ),
}));

import type { Visual } from "../api/types";
import CanvasGrid, { layoutFor } from "./CanvasGrid";

const visuals: Visual[] = [
  { id: "a", type: "bar", title: "", layout: { x: 0, y: 0, w: 6, h: 6 }, wells: {}, options: {}, filters: [] },
  { id: "b", type: "kpi", title: "", layout: { x: 6, y: 0, w: 3, h: 3 }, wells: {}, options: {}, filters: [] },
];

describe("CanvasGrid", () => {
  it("renders one tile per visual", () => {
    render(
      <CanvasGrid
        visuals={visuals}
        canvas={{ columns: 12, rowHeight: 40 }}
        view={{ database: "A", schema: "B", name: "C" }}
        selectedId={null}
        onSelect={() => {}}
        onLayoutChange={() => {}}
      />,
    );
    expect(screen.getByTestId("tile-a")).toBeInTheDocument();
    expect(screen.getByTestId("tile-b")).toBeInTheDocument();
  });

  it("invites the user to add a visual when the canvas is empty", () => {
    render(
      <CanvasGrid
        visuals={[]}
        canvas={{ columns: 12, rowHeight: 40 }}
        view={{ database: "A", schema: "B", name: "C" }}
        selectedId={null}
        onSelect={() => {}}
        onLayoutChange={() => {}}
      />,
    );
    expect(screen.getByText(/add a visual/i)).toBeInTheDocument();
  });
});

describe("layoutFor", () => {
  it("keeps the author's arrangement on a wide canvas", () => {
    expect(layoutFor(visuals, false)).toEqual([
      { i: "a", x: 0, y: 0, w: 6, h: 6, minW: 2, minH: 3 },
      { i: "b", x: 6, y: 0, w: 3, h: 3, minW: 2, minH: 2 },
    ]);
  });

  it("lets a card or a table shrink to what it shows, and keeps a chart drawable", () => {
    // A chart needs an aspect ratio; a number, a card of numbers or a
    // header-and-a-row table needs only the height of its own lines. A
    // three-row floor left a number card with a white band under it that
    // no drag could remove.
    const kinds = ["kpi", "multiCard", "table", "matrix", "slicer"] as const;
    const short = kinds.map((type, i) => ({ ...visuals[1], id: type, type, layout: { x: 0, y: i, w: 3, h: 2 } }));
    expect(layoutFor(short, false).map((item) => [item.i, item.minH])).toEqual(
      kinds.map((type) => [type, 2]),
    );
    const chart = layoutFor([{ ...visuals[0], type: "line" }], false);
    expect(chart[0].minH).toBe(3);
  });

  it("stacks into one full-width column on a narrow one", () => {
    const stacked = layoutFor(visuals, true);
    expect(stacked.every((item) => item.x === 0 && item.w === 1)).toBe(true);
    // Reading order: same row, so left-to-right.
    expect(stacked.map((item) => item.i)).toEqual(["a", "b"]);
    // No overlap -- each tile starts where the previous one ended.
    expect(stacked[1].y).toBe(stacked[0].h);
  });

  it("gives a short tile enough height to draw in", () => {
    // The KPI card is 3 rows on the desktop grid, which is unreadable once
    // it is the full width of a phone.
    const [, card] = layoutFor(visuals, true);
    expect(card.h).toBeGreaterThanOrEqual(6);
  });

  it("orders top-to-bottom before left-to-right", () => {
    const lower: Visual[] = [
      { ...visuals[0], id: "low", layout: { x: 0, y: 8, w: 6, h: 4 } },
      { ...visuals[0], id: "right", layout: { x: 6, y: 0, w: 6, h: 4 } },
      { ...visuals[0], id: "left", layout: { x: 0, y: 0, w: 6, h: 4 } },
    ];
    expect(layoutFor(lower, true).map((i) => i.i)).toEqual(["left", "right", "low"]);
  });

  it("makes every stacked tile static, so a touch drag stays a scroll", () => {
    expect(layoutFor(visuals, true).every((item) => item.static)).toBe(true);
  });
});
