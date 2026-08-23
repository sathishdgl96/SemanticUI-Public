import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  setOnAuthExpired: vi.fn(),
  ApiError: class extends Error {
    code: string; status: number; detail?: string | null;
    constructor(code: string, status: number, message: string, detail?: string | null) {
      super(message); this.code = code; this.status = status; this.detail = detail;
    }
  },
}));
// A clickable stand-in rather than an inert div: drill-down and
// cross-filtering are both "the user clicked a mark", and a div that swallows
// clicks would let those tests pass without the wiring existing.
vi.mock("./AutoChartAdapter", () => ({
  default: ({
    title,
    categories = [],
    onMarkClick,
  }: {
    title: string;
    categories?: string[];
    onMarkClick?: (c: string) => void;
  }) =>
    onMarkClick ? (
      <button
        type="button"
        aria-label={title}
        onClick={() => onMarkClick(categories[0] ?? "EAST")}
      >
        chart
      </button>
    ) : (
      <div data-testid="chart" role="img" aria-label={title} />
    ),
}));

import { apiFetch, ApiError } from "../api/client";
import type { Hierarchy, ViewRef, Visual } from "../api/types";
import type { CrossFilter, DrillState } from "./filters";
import VisualTile from "./VisualTile";

const apiFetchMock = vi.mocked(apiFetch);
const view: ViewRef = { database: "A", schema: "B", name: "SALES" };

function visual(over: Partial<Visual> = {}): Visual {
  return {
    id: "v1", type: "bar", title: "",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells: { axis: ["C.REGION"], legend: [], values: ["A.REVENUE"] },
    options: {}, filters: [], ...over,
  };
}

interface TileOpts {
  hierarchies?: Hierarchy[];
  drill?: DrillState;
  onDrill?: (next: DrillState | undefined) => void;
  crossFilter?: CrossFilter | null;
  onCrossFilter?: (next: CrossFilter | null) => void;
}

function renderTile(v: Visual, opts: TileOpts = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VisualTile visual={v} view={view} selected={false} onSelect={() => {}} {...opts} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // Block body is load-bearing, not style: an implicit-return arrow here
  // would make this `beforeEach` return `mockReset()`'s result, and
  // `mockReset()` returns the mock function itself (for chaining). Vitest
  // treats any function a `beforeEach` returns as a per-test cleanup
  // callback and invokes it after the test with no arguments — which would
  // silently re-invoke `apiFetch` a second time post-test, surfacing as an
  // unhandled rejection whenever that test's mocked behaviour rejects.
  apiFetchMock.mockReset();
});

describe("VisualTile", () => {
  it("asks for fields instead of querying when the wells are incomplete", async () => {
    renderTile(visual({ wells: { axis: [], legend: [], values: [] } }));
    expect(await screen.findByText(/needs fields/i)).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("renders the composed heading and queries once complete", async () => {
    apiFetchMock.mockResolvedValue({
      columns: [{ name: "REGION", type: "TEXT" }, { name: "REVENUE", type: "FIXED" }],
      rows: [["EAST", 10]], truncated: false, sfqid: null, sql: "",
    });
    renderTile(visual());
    expect(await screen.findByText("REVENUE by REGION")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/query/semantic",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps a failure inside its own tile", async () => {
    apiFetchMock.mockRejectedValue(
      new ApiError("SNOWFLAKE_FORBIDDEN", 403, "Insufficient privileges on ORDERS"),
    );
    renderTile(visual());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/insufficient privileges/i);
    // The heading is still there: the tile degraded, it did not disappear.
    expect(screen.getByText("REVENUE by REGION")).toBeInTheDocument();
  });

  it("renders a KPI value as text rather than a chart", async () => {
    apiFetchMock.mockResolvedValue({
      columns: [{ name: "REVENUE", type: "FIXED" }],
      rows: [[1234567]], truncated: false, sfqid: null, sql: "",
    });
    renderTile(visual({ type: "kpi", wells: { value: ["A.REVENUE"] } }));
    expect(await screen.findByTestId("kpi-value")).toHaveTextContent("1,234,567");
  });
});

// --- hierarchies, drill-down and cross-filtering ---------------------------

const GEO: Hierarchy = {
  id: "h1",
  name: "Geography",
  levels: ["C.COUNTRY", "C.STATE", "C.CITY"],
};

function hierarchyVisual(): Visual {
  return visual({
    title: "By geography",
    wells: { axis: ["hierarchy:h1"], legend: [], values: ["A.REVENUE"] },
  });
}

/** The dimension column must match the well the visual is currently showing,
 *  or buildVisualOption returns null and the tile renders "nothing to chart"
 *  instead of a chart -- which reads as a missing click handler. */
function stubRows(dimension = "COUNTRY", value = "US") {
  apiFetchMock.mockResolvedValue({
    columns: [
      { name: dimension, type: "TEXT" },
      { name: "REVENUE", type: "FIXED" },
    ],
    rows: [[value, 10]],
    truncated: false,
    sfqid: null,
    sql: "",
  });
}

describe("VisualTile title size", () => {
  it("hands a chosen size to the stylesheet rather than fixing it inline", async () => {
    // The stylesheet caps it against the tile's own width. An inline
    // font-size would win over that cap and run a 20px title out of the
    // header on a small tile.
    apiFetchMock.mockResolvedValue({
      columns: [{ name: "REGION", type: "TEXT" }],
      rows: [["EU"]],
      truncated: false,
      sfqid: null,
      sql: "",
    });
    renderTile(visual({ title: "Revenue", options: { titleFontSize: 20 } }));
    const heading = await screen.findByRole("heading", { name: "Revenue" });
    expect(heading.style.getPropertyValue("--title-size")).toBe("20px");
    expect(heading.style.fontSize).toBe("");
  });

  it("sets nothing when no size was chosen", async () => {
    apiFetchMock.mockResolvedValue({
      columns: [{ name: "REGION", type: "TEXT" }],
      rows: [["EU"]],
      truncated: false,
      sfqid: null,
      sql: "",
    });
    renderTile(visual({ title: "Revenue" }));
    const heading = await screen.findByRole("heading", { name: "Revenue" });
    expect(heading.getAttribute("style")).toBeNull();
  });
});

describe("VisualTile hierarchies", () => {
  it("names the current level in an untitled tile rather than the reference", async () => {
    stubRows();
    renderTile(
      visual({ wells: { axis: ["hierarchy:h1"], legend: [], values: ["A.REVENUE"] } }),
      { hierarchies: [GEO] },
    );
    expect(await screen.findByText("REVENUE by COUNTRY")).toBeInTheDocument();
  });

  it("shows no breadcrumb when undrilled", async () => {
    stubRows();
    renderTile(hierarchyVisual(), { hierarchies: [GEO], onDrill: () => {} });
    await screen.findByRole("button", { name: /by geography/i });
    expect(screen.queryByRole("navigation", { name: /drill path/i })).toBeNull();
  });

  it("drilling a mark advances the level and records the path", async () => {
    stubRows();
    const onDrill = vi.fn();
    renderTile(hierarchyVisual(), { hierarchies: [GEO], onDrill });
    await userEvent.click(await screen.findByRole("button", { name: /by geography/i }));
    expect(onDrill).toHaveBeenCalledWith({
      hierarchyId: "h1",
      path: [{ field: "C.COUNTRY", value: "US" }],
    });
  });

  it("shows a breadcrumb and an up control once drilled", async () => {
    stubRows();
    renderTile(hierarchyVisual(), {
      hierarchies: [GEO],
      onDrill: () => {},
      drill: { hierarchyId: "h1", path: [{ field: "C.COUNTRY", value: "US" }] },
    });
    const nav = await screen.findByRole("navigation", { name: /drill path/i });
    expect(nav).toHaveTextContent("US");
    expect(screen.getByRole("button", { name: /drill up/i })).toBeInTheDocument();
  });

  it("drill up pops one level", async () => {
    stubRows();
    const onDrill = vi.fn();
    renderTile(hierarchyVisual(), {
      hierarchies: [GEO],
      onDrill,
      drill: {
        hierarchyId: "h1",
        path: [
          { field: "C.COUNTRY", value: "US" },
          { field: "C.STATE", value: "CA" },
        ],
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: /drill up/i }));
    expect(onDrill).toHaveBeenCalledWith({
      hierarchyId: "h1",
      path: [{ field: "C.COUNTRY", value: "US" }],
    });
  });

  it("drilling up from the first level clears the drill state entirely", async () => {
    stubRows();
    const onDrill = vi.fn();
    renderTile(hierarchyVisual(), {
      hierarchies: [GEO],
      onDrill,
      drill: { hierarchyId: "h1", path: [{ field: "C.COUNTRY", value: "US" }] },
    });
    await userEvent.click(await screen.findByRole("button", { name: /drill up/i }));
    expect(onDrill).toHaveBeenCalledWith(undefined);
  });

  it("stops offering a drill at the last level", async () => {
    stubRows("CITY", "SF");
    const onDrill = vi.fn();
    renderTile(hierarchyVisual(), {
      hierarchies: [GEO],
      onDrill,
      drill: {
        hierarchyId: "h1",
        path: [
          { field: "C.COUNTRY", value: "US" },
          { field: "C.STATE", value: "CA" },
        ],
      },
    });
    // No cross-filter handler either, so the chart must not be interactive at
    // all -- it falls back to the inert stand-in.
    expect(await screen.findByTestId("chart")).toBeInTheDocument();
    expect(onDrill).not.toHaveBeenCalled();
  });

  it("Backspace drills up", async () => {
    stubRows();
    const onDrill = vi.fn();
    renderTile(hierarchyVisual(), {
      hierarchies: [GEO],
      onDrill,
      drill: { hierarchyId: "h1", path: [{ field: "C.COUNTRY", value: "US" }] },
    });
    const tile = await screen.findByRole("region", { name: /by geography/i });
    tile.focus();
    await userEvent.type(tile, "{Backspace}");
    expect(onDrill).toHaveBeenCalledWith(undefined);
  });

  it("reports a hierarchy that has vanished without blanking the tile", async () => {
    stubRows();
    renderTile(hierarchyVisual(), { hierarchies: [] });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /hierarchy this visual uses is no longer defined/i,
    );
    expect(screen.getByText("By geography")).toBeInTheDocument();
  });
});

describe("VisualTile cross-filtering", () => {
  it("reports a clicked mark as a selection from this visual", async () => {
    stubRows("REGION", "EAST");
    const onCrossFilter = vi.fn();
    renderTile(visual({ title: "Revenue" }), { onCrossFilter });
    await userEvent.click(await screen.findByRole("button", { name: "Revenue" }));
    expect(onCrossFilter).toHaveBeenCalledWith({
      sourceVisualId: "v1",
      field: "C.REGION",
      value: "EAST",
    });
  });

  it("clicking the same mark again clears the selection", async () => {
    stubRows("REGION", "EAST");
    const onCrossFilter = vi.fn();
    renderTile(visual({ title: "Revenue" }), {
      onCrossFilter,
      crossFilter: { sourceVisualId: "v1", field: "C.REGION", value: "EAST" },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Revenue" }));
    expect(onCrossFilter).toHaveBeenCalledWith(null);
  });

  it("prefers drilling over cross-filtering when both are possible", async () => {
    stubRows();
    const onDrill = vi.fn();
    const onCrossFilter = vi.fn();
    renderTile(hierarchyVisual(), { hierarchies: [GEO], onDrill, onCrossFilter });
    await userEvent.click(await screen.findByRole("button", { name: /by geography/i }));
    expect(onDrill).toHaveBeenCalled();
    expect(onCrossFilter).not.toHaveBeenCalled();
  });
});
