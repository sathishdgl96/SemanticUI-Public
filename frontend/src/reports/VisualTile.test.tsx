import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
vi.mock("./AutoChartAdapter", () => ({ default: () => <div data-testid="chart" /> }));

import { apiFetch, ApiError } from "../api/client";
import type { ViewRef, Visual } from "../api/types";
import VisualTile from "./VisualTile";

const apiFetchMock = vi.mocked(apiFetch);
const view: ViewRef = { database: "A", schema: "B", name: "SALES" };

function visual(over: Partial<Visual> = {}): Visual {
  return {
    id: "v1", type: "bar", title: "",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells: { axis: ["C.REGION"], legend: [], values: ["A.REVENUE"] },
    options: {}, ...over,
  };
}

function renderTile(v: Visual) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VisualTile visual={v} view={view} selected={false} onSelect={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => apiFetchMock.mockReset());

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
