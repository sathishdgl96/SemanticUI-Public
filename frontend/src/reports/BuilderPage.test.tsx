import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/reports", () => ({
  getReport: vi.fn(), updateReport: vi.fn(), exportReport: vi.fn(), importReport: vi.fn(),
}));
vi.mock("../api/client", () => ({
  apiFetch: vi.fn().mockResolvedValue({ columns: [], rows: [], truncated: false, sfqid: null, sql: "" }),
  setOnAuthExpired: vi.fn(),
  ApiError: class extends Error {},
}));
vi.mock("./CanvasGrid", () => ({
  default: ({ visuals, onSelect }: { visuals: { id: string }[]; onSelect: (id: string) => void }) => (
    <div>
      {visuals.map((v) => (
        <button key={v.id} onClick={() => onSelect(v.id)}>{`select ${v.id}`}</button>
      ))}
    </div>
  ),
}));

import { getReport, updateReport } from "../api/reports";
import BuilderPage from "./BuilderPage";

const getMock = vi.mocked(getReport);
const updateMock = vi.mocked(updateReport);

const detail = {
  id: "r1",
  name: "Sales overview",
  view: { database: "ANALYTICS", schema: "PUBLIC", name: "SALES" },
  updatedAt: "2026-08-15T10:00:00+00:00",
  definition: {
    schemaVersion: 1,
    name: "Sales overview",
    view: { database: "ANALYTICS", schema: "PUBLIC", name: "SALES" },
    canvas: { columns: 12, rowHeight: 40 },
    visuals: [
      {
        id: "v1", type: "bar", title: "",
        layout: { x: 0, y: 0, w: 6, h: 6 },
        wells: { axis: ["C.REGION"], legend: [], values: ["A.REV"] },
        options: {},
      },
    ],
  },
};

function renderBuilder() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/reports/r1"]}>
        <Routes>
          <Route path="/reports/:id" element={<BuilderPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  updateMock.mockReset();
  getMock.mockResolvedValue(detail);
});

describe("BuilderPage", () => {
  it("shows the report name and both panes", async () => {
    renderBuilder();
    expect(await screen.findByDisplayValue("Sales overview")).toBeInTheDocument();
    expect(screen.getByText(/visualizations/i)).toBeInTheDocument();
    expect(screen.getByText(/^fields$/i)).toBeInTheDocument();
  });

  it("asks the user to pick a visual before showing wells", async () => {
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    expect(screen.getByText(/select a visual/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "select v1" }));
    expect(await screen.findByRole("region", { name: "Axis" })).toBeInTheDocument();
  });

  it("keeps Save disabled until something changes, then saves the definition", async () => {
    updateMock.mockResolvedValue(detail);
    renderBuilder();
    const save = await screen.findByRole("button", { name: /^save$/i });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "select v1" }));
    await userEvent.click(screen.getByRole("button", { name: /remove C\.REGION/i }));
    expect(await screen.findByRole("button", { name: /^save$/i })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const [, savedDefinition] = updateMock.mock.calls[0];
    expect(savedDefinition.visuals[0].wells.axis).toEqual([]);
  });

  it("offers to rebind when the bound view no longer resolves", async () => {
    // The describe call is the /api/semantic-views/... fetch made through
    // apiFetch; make it reject and assert the builder explains rather than
    // rendering an empty canvas.
    const { apiFetch } = await import("../api/client");
    vi.mocked(apiFetch).mockRejectedValueOnce(
      Object.assign(new Error("Semantic view not found"), {
        code: "QUERY_ERROR", status: 400,
      }),
    );
    renderBuilder();
    expect(await screen.findByText(/ANALYTICS\.PUBLIC\.SALES/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /choose another view/i })).toBeInTheDocument();
  });

  it("reports wells dropped by a type change", async () => {
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: "select v1" }));
    await userEvent.click(screen.getByRole("button", { name: /^pie$/i }));
    expect(await screen.findByText(/axis/i)).toBeInTheDocument();
  });
});
