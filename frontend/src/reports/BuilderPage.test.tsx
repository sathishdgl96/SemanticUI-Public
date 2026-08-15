import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/reports", () => ({
  getReport: vi.fn(), updateReport: vi.fn(), exportReport: vi.fn(), importReport: vi.fn(),
}));
// A real constructor (matching ImportPanel.test.tsx's mock) rather than a
// bare `class extends Error {}`: `isMissingView` in BuilderPage.tsx uses
// `instanceof ApiError` (real `apiFetch` only ever throws real `ApiError`
// instances), so a test rejecting with a plain `Error` wouldn't exercise
// the same path production traffic does.
vi.mock("../api/client", () => ({
  apiFetch: vi.fn().mockResolvedValue({ columns: [], rows: [], truncated: false, sfqid: null, sql: "" }),
  setOnAuthExpired: vi.fn(),
  ApiError: class extends Error {
    code: string; status: number; detail?: string | null;
    constructor(code: string, status: number, message: string, detail?: string | null) {
      super(message); this.code = code; this.status = status; this.detail = detail;
    }
  },
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

import { apiFetch, ApiError } from "../api/client";
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

// A second, distinct report — used to prove the builder resets its working
// copy when the route's :id changes under the same mounted instance
// (App.tsx doesn't `key` the route element).
const detail2 = {
  id: "r2",
  name: "Marketing overview",
  view: { database: "ANALYTICS", schema: "PUBLIC", name: "SALES" },
  updatedAt: "2026-08-15T10:00:00+00:00",
  definition: {
    schemaVersion: 1,
    name: "Marketing overview",
    view: { database: "ANALYTICS", schema: "PUBLIC", name: "SALES" },
    canvas: { columns: 12, rowHeight: 40 },
    visuals: [],
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
    // apiFetch; make it reject with a real ApiError (as production's
    // apiFetch always does) and assert the builder explains rather than
    // rendering an empty canvas.
    vi.mocked(apiFetch).mockRejectedValueOnce(
      new ApiError("QUERY_ERROR", 400, "Semantic view not found"),
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

  it("shows an error instead of loading forever when the report fails to load", async () => {
    getMock.mockReset();
    getMock.mockRejectedValue(new ApiError("HTTP_ERROR", 404, "Report not found"));
    renderBuilder();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/report not found/i);
    expect(screen.queryByText(/loading report/i)).not.toBeInTheDocument();
  });

  it("resets the working copy when navigating to a different report", async () => {
    getMock.mockReset();
    getMock.mockImplementation((requestedId: string) =>
      Promise.resolve(requestedId === "r2" ? detail2 : detail),
    );

    function Nav() {
      const navigate = useNavigate();
      return (
        <button onClick={() => navigate("/reports/r2")}>go to r2</button>
      );
    }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/reports/r1"]}>
          <Nav />
          <Routes>
            <Route path="/reports/:id" element={<BuilderPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByDisplayValue("Sales overview")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /go to r2/i }));
    expect(await screen.findByDisplayValue("Marketing overview")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Sales overview")).not.toBeInTheDocument();
  });

  it("does not duplicate a field when its row is clicked twice", async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      tables: [],
      relationships: [],
      dimensions: [{ table: "C", name: "REGION", dataType: "TEXT" }],
      metrics: [
        { table: "A", name: "REV", dataType: "NUMBER" },
        { table: "A", name: "PROFIT", dataType: "NUMBER" },
      ],
      facts: [],
    });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: "select v1" }));
    const row = await screen.findByRole("button", { name: /A\.PROFIT/i });
    await userEvent.click(row);
    await userEvent.click(row);
    const values = await screen.findByRole("region", { name: "Values" });
    expect(within(values).getAllByText("A.PROFIT")).toHaveLength(1);
  });

  it("surfaces a save failure instead of pretending the edit persisted", async () => {
    updateMock.mockRejectedValue(new ApiError("REPORT_LOCKED", 409, "Report is locked"));
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: "select v1" }));
    await userEvent.click(screen.getByRole("button", { name: /remove C\.REGION/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/report is locked/i);
  });

  it("surfaces a refresh-fields failure instead of failing silently", async () => {
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    vi.mocked(apiFetch).mockRejectedValueOnce(
      new ApiError("QUERY_ERROR", 400, "Describe failed"),
    );
    await userEvent.click(screen.getByRole("button", { name: /refresh fields/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/describe failed/i);
  });

  it("clears a stale save-failure alert when navigating to a different report", async () => {
    // Same shape as "resets the working copy when navigating to a different
    // report": fail a Save on r1 so its alert appears, then navigate to r2
    // (same mounted instance) and assert r1's failure isn't still attributed
    // to r2.
    getMock.mockReset();
    getMock.mockImplementation((requestedId: string) =>
      Promise.resolve(requestedId === "r2" ? detail2 : detail),
    );
    updateMock.mockRejectedValue(new ApiError("REPORT_LOCKED", 409, "Report is locked"));

    function Nav() {
      const navigate = useNavigate();
      return (
        <button onClick={() => navigate("/reports/r2")}>go to r2</button>
      );
    }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/reports/r1"]}>
          <Nav />
          <Routes>
            <Route path="/reports/:id" element={<BuilderPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByDisplayValue("Sales overview")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "select v1" }));
    await userEvent.click(screen.getByRole("button", { name: /remove C\.REGION/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/report is locked/i);

    await userEvent.click(screen.getByRole("button", { name: /go to r2/i }));
    expect(await screen.findByDisplayValue("Marketing overview")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
