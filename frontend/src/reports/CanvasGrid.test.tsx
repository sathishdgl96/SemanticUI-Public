import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./VisualTile", () => ({
  default: ({ visual }: { visual: { id: string } }) => (
    <div data-testid={`tile-${visual.id}`}>{visual.id}</div>
  ),
}));

import type { Visual } from "../api/types";
import CanvasGrid from "./CanvasGrid";

const visuals: Visual[] = [
  { id: "a", type: "bar", title: "", layout: { x: 0, y: 0, w: 6, h: 6 }, wells: {}, options: {} },
  { id: "b", type: "kpi", title: "", layout: { x: 6, y: 0, w: 3, h: 3 }, wells: {}, options: {} },
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
