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
  default: ({
    visuals,
    onSelect,
    onDrill,
    onCrossFilter,
  }: {
    visuals: { id: string }[];
    onSelect: (id: string) => void;
    onDrill?: (id: string, next: unknown) => void;
    onCrossFilter?: (next: unknown) => void;
  }) => (
    <div>
      {visuals.map((v) => (
        <div key={v.id}>
          <button onClick={() => onSelect(v.id)}>{`select ${v.id}`}</button>
          {/* Stand-ins for clicking a mark. The real canvas raises these from
              VisualTile; the builder only has to route and hold them. */}
          <button
            onClick={() =>
              onCrossFilter?.({ sourceVisualId: v.id, field: "C.REGION", value: "EAST" })
            }
          >{`cross-filter ${v.id}`}</button>
          <button
            onClick={() =>
              onDrill?.(v.id, {
                hierarchyId: "h1",
                path: [{ field: "C.COUNTRY", value: "US" }],
              })
            }
          >{`drill ${v.id}`}</button>
        </div>
      ))}
    </div>
  ),
}));

import { apiFetch, ApiError } from "../api/client";
import { getReport, updateReport } from "../api/reports";
import BuilderPage from "./BuilderPage";

const apiFetchMock = vi.mocked(apiFetch);
const getMock = vi.mocked(getReport);
const updateMock = vi.mocked(updateReport);

const detail = {
  id: "r1",
  name: "Sales overview",
  view: { database: "ANALYTICS", schema: "PUBLIC", name: "SALES" },
  updatedAt: "2026-08-15T10:00:00+00:00",
  workspaceId: "w0",
  workspaceName: "My reports",
  myRole: "admin" as const,
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
        filters: [],
      },
    ],
    filters: [],
    hierarchies: [],
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
  workspaceId: "w0",
  workspaceName: "My reports",
  myRole: "admin" as const,
  definition: {
    schemaVersion: 1,
    name: "Marketing overview",
    view: { database: "ANALYTICS", schema: "PUBLIC", name: "SALES" },
    canvas: { columns: 12, rowHeight: 40 },
    visuals: [],
    filters: [],
    hierarchies: [],
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
    // The Fields section became the PBI tri-pane's Data pane.
    expect(screen.getByRole("region", { name: "Visualizations" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Data" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Filters" })).toBeInTheDocument();
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

  it("prompts to pick a semantic view for a brand-new, unbound report", async () => {
    // Mirrors what ReportListPage's "New report" now creates: an empty
    // view (all fields "") and no visuals. The builder must treat this as
    // "no view bound yet", not crash or render a blank canvas.
    getMock.mockResolvedValue({
      id: "r1",
      name: "Untitled report",
      workspaceId: "w0",
      workspaceName: "My reports",
      myRole: "admin" as const,
      view: { database: "", schema: "", name: "" },
      updatedAt: "2026-08-15T10:00:00+00:00",
      definition: {
        schemaVersion: 1,
        name: "Untitled report",
        view: { database: "", schema: "", name: "" },
        canvas: { columns: 12, rowHeight: 40 },
        visuals: [],
        filters: [],
        hierarchies: [],
      },
    });
    vi.mocked(apiFetch).mockResolvedValue({ views: [] });
    renderBuilder();
    expect(await screen.findByText(/pick a semantic view to start this report/i)).toBeInTheDocument();
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

// --- filters, hierarchies, drill and cross-filtering ----------------------

/** The default apiFetch mock answers every URL with an empty query result,
 *  which leaves the Fields and Filters panes with nothing to offer. Route by
 *  URL so DESCRIBE returns a real catalog. */
function stubApi() {
  apiFetchMock.mockImplementation((path: string) => {
    if (path.startsWith("/api/semantic-views/") && path.includes("/values")) {
      return Promise.resolve({ values: ["EAST", "WEST"], truncated: false });
    }
    if (path.startsWith("/api/semantic-views/")) {
      return Promise.resolve({
        tables: [{ name: "C" }, { name: "A" }],
        relationships: [],
        dimensions: [
          { table: "C", name: "REGION", dataType: "TEXT" },
          { table: "C", name: "COUNTRY", dataType: "TEXT" },
        ],
        metrics: [{ table: "A", name: "REV", dataType: "NUMBER(38,2)" }],
        facts: [],
        modelHierarchies: [],
      });
    }
    if (path.includes("/connect")) {
      return Promise.resolve({
        account: "ACME",
        database: "ANALYTICS",
        schema: "PUBLIC",
        view: "SALES",
        sheets: [{ title: "Revenue by region", sql: "SELECT 1" }],
      });
    }
    if (path === "/api/workspaces") {
      return Promise.resolve({
        workspaces: [
          { id: "w0", name: "My reports", kind: "personal", myRole: "admin",
            memberCount: 1, reportCount: 1 },
          { id: "w1", name: "Team", kind: "shared", myRole: "editor",
            memberCount: 3, reportCount: 2 },
          // Present precisely so the Move control can be asserted NOT to
          // offer it: moving needs editor on both ends.
          { id: "w2", name: "Read only", kind: "shared", myRole: "viewer",
            memberCount: 9, reportCount: 4 },
        ],
      });
    }
    if (path.includes("/move")) {
      return Promise.resolve({ ...detail, workspaceId: "w1" });
    }
    return Promise.resolve({
      columns: [],
      rows: [],
      truncated: false,
      sfqid: null,
      sql: "",
    });
  });
}

describe("BuilderPage filters", () => {
  beforeEach(() => stubApi());

  it("offers both filter scopes once a visual is selected", async () => {
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    expect(
      await screen.findByLabelText(/add a filter on this page/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/add a filter on this visual/i)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "select v1" }));
    expect(
      await screen.findByLabelText(/add a filter on this visual/i),
    ).toBeInTheDocument();
  });

  it("adding a report filter marks the report dirty and saves it", async () => {
    updateMock.mockResolvedValue(detail);
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();

    await userEvent.selectOptions(
      await screen.findByLabelText(/add a filter on this page/i),
      "C.REGION",
    );
    expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const [, saved] = updateMock.mock.calls[0];
    expect(saved.filters).toEqual([
      expect.objectContaining({ field: "C.REGION", op: "is", values: [] }),
    ]);
  });

  it("does not offer a hierarchy until one is defined, then lists it", async () => {
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    expect(await screen.findByText(/no hierarchies yet/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /new hierarchy/i }));
    expect(
      await screen.findByLabelText(/hierarchy name for New hierarchy/i),
    ).toBeInTheDocument();
  });

  it("saves a hierarchy but never a model-declared one", async () => {
    updateMock.mockResolvedValue(detail);
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await userEvent.click(await screen.findByRole("button", { name: /new hierarchy/i }));
    await userEvent.selectOptions(
      await screen.findByLabelText(/add a level to New hierarchy/i),
      "C.REGION",
    );
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const [, saved] = updateMock.mock.calls.at(-1)!;
    expect(saved.hierarchies).toEqual([
      expect.objectContaining({ name: "New hierarchy", levels: ["C.REGION"] }),
    ]);
    expect(JSON.stringify(saved)).not.toContain("model:");
  });
});

describe("BuilderPage cross-filtering", () => {
  beforeEach(() => stubApi());

  it("shows a labelled chip while a selection is active, and clears it", async () => {
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    // Queried by text, not by role="status": DndContext renders its own
    // live region with that role, so the role query is ambiguous here.
    expect(screen.queryByText(/filtered by/i)).toBeNull();

    await userEvent.click(await screen.findByRole("button", { name: "cross-filter v1" }));
    const chip = await screen.findByText(/filtered by/i);
    expect(chip).toHaveTextContent("C.REGION");
    expect(chip).toHaveTextContent("EAST");
    // Still announced: the chip itself carries role="status".
    expect(chip).toHaveAttribute("role", "status");

    await userEvent.click(screen.getByRole("button", { name: /clear cross-filter/i }));
    expect(screen.queryByText(/filtered by/i)).toBeNull();
  });

  it("keeps the selection and the drill position out of the saved definition", async () => {
    updateMock.mockResolvedValue(detail);
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");

    await userEvent.click(await screen.findByRole("button", { name: "cross-filter v1" }));
    await userEvent.click(screen.getByRole("button", { name: "drill v1" }));

    // Neither is a change to the document, so Save is still disabled --
    // which is itself the assertion that they are view state.
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();

    // Force a real change, then check what actually goes over the wire.
    await userEvent.selectOptions(
      await screen.findByLabelText(/add a filter on this page/i),
      "C.REGION",
    );
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const [, saved] = updateMock.mock.calls.at(-1)!;
    const json = JSON.stringify(saved);
    expect(json).not.toContain("sourceVisualId");
    expect(json).not.toContain("drillPath");
    expect(json).not.toContain("hierarchyId");
  });
});

describe("BuilderPage hierarchy placement", () => {
  beforeEach(() => stubApi());

  it("offers a defined hierarchy as a placeable field", async () => {
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    // Nothing to place before one exists.
    expect(screen.queryByRole("heading", { name: /^hierarchies$/i, level: 4 })).toBeNull();

    await userEvent.click(await screen.findByRole("button", { name: /new hierarchy/i }));
    await userEvent.selectOptions(
      await screen.findByLabelText(/add a level to New hierarchy/i),
      "C.REGION",
    );
    await userEvent.selectOptions(
      await screen.findByLabelText(/add a level to New hierarchy/i),
      "C.COUNTRY",
    );

    expect(
      await screen.findByRole("button", { name: /New hierarchy hierarchy, 2 levels/i }),
    ).toBeInTheDocument();
  });

  it("places a hierarchy on the selected visual's axis", async () => {
    updateMock.mockResolvedValue(detail);
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await userEvent.click(await screen.findByRole("button", { name: /new hierarchy/i }));
    await userEvent.selectOptions(
      await screen.findByLabelText(/add a level to New hierarchy/i),
      "C.REGION",
    );
    await userEvent.selectOptions(
      await screen.findByLabelText(/add a level to New hierarchy/i),
      "C.COUNTRY",
    );

    await userEvent.click(screen.getByRole("button", { name: "select v1" }));
    // The axis already holds C.REGION; clear it so the hierarchy can land
    // there. Scoped to the Axis well: the hierarchy pane also offers a
    // "Remove C.REGION" for its own level list.
    const axis = await screen.findByRole("region", { name: "Axis" });
    await userEvent.click(within(axis).getByRole("button", { name: /remove C\.REGION/i }));
    await userEvent.click(
      screen.getByRole("button", { name: /New hierarchy hierarchy, 2 levels/i }),
    );

    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const [, saved] = updateMock.mock.calls.at(-1)!;
    expect(saved.visuals[0].wells.axis[0]).toMatch(/^hierarchy:/);
  });
});

describe("BuilderPage roles", () => {
  beforeEach(() => stubApi());

  it("lets an editor save", async () => {
    getMock.mockResolvedValue({ ...detail, myRole: "editor" as const });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: "select v1" }));
    const axis = await screen.findByRole("region", { name: "Axis" });
    await userEvent.click(within(axis).getByRole("button", { name: /remove C\.REGION/i }));
    expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();
  });

  it("disables Save for a viewer and says why", async () => {
    getMock.mockResolvedValue({ ...detail, myRole: "viewer" as const });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    expect(screen.getByText(/read-only for you/i)).toBeInTheDocument();
    // And it says the data still runs on their own credentials, so read-only
    // is not mistaken for "this report is broken".
    expect(screen.getByText(/your own\s+Snowflake credentials/i)).toBeInTheDocument();
  });

  it("does not offer Import or Move to a viewer", async () => {
    getMock.mockResolvedValue({ ...detail, myRole: "viewer" as const });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    expect(screen.queryByRole("button", { name: /^import$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^move$/i })).toBeNull();
  });

  it("still lets a viewer export", async () => {
    getMock.mockResolvedValue({ ...detail, myRole: "viewer" as const });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    expect(screen.getByRole("button", { name: /^export$/i })).toBeEnabled();
  });

  it("offers Move only to workspaces I can write to", async () => {
    getMock.mockResolvedValue({ ...detail, myRole: "editor" as const });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: /^move$/i }));
    await screen.findByRole("option", { name: "Team" });
    const select = screen.getByLabelText(/move to/i) as HTMLSelectElement;
    const names = [...select.options].map((o) => o.textContent);
    expect(names).toContain("Team");
    expect(names).not.toContain("Read only");
  });

  it("moves the report to the chosen workspace", async () => {
    getMock.mockResolvedValue({ ...detail, myRole: "editor" as const });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: /^move$/i }));
    await screen.findByRole("option", { name: "Team" });
    await userEvent.selectOptions(screen.getByLabelText(/move to/i), "w1");
    await userEvent.click(screen.getByRole("button", { name: /move report/i }));

    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find(([url]) =>
        String(url).includes("/move"),
      );
      expect(call?.[0]).toBe("/api/reports/r1/move");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ workspaceId: "w1" });
    });
  });
});

describe("BuilderPage Excel export", () => {
  beforeEach(() => stubApi());

  it("posts one sheet per visual to the xlsx endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: async () => new Blob(["x"]),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
    });
    try {
      renderBuilder();
      await screen.findByDisplayValue("Sales overview");
      await userEvent.click(screen.getByRole("button", { name: /^excel$/i }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/reports/r1/export.xlsx");
      // same-origin: the export runs every visual's query on the user's own
      // Snowflake connection, so it needs their session.
      expect(init.credentials).toBe("same-origin");
      const body = JSON.parse(init.body);
      expect(body.sheets).toHaveLength(1);
      expect(body.sheets[0].metrics).toEqual(["A.REV"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("offers a Connect live panel", async () => {
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: /connect live/i }));
    expect(
      await screen.findByRole("region", { name: /connect from excel/i }),
    ).toBeInTheDocument();
  });

  it("offers both to a viewer, since exporting and copying SQL are reading", async () => {
    getMock.mockResolvedValue({ ...detail, myRole: "viewer" as const });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    expect(screen.getByRole("button", { name: /^excel$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /connect live/i })).toBeEnabled();
  });
});

describe("BuilderPage PBI panes", () => {
  beforeEach(() => stubApi());

  it("collapsing the Data pane tucks it into a strip and back", async () => {
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    expect(await screen.findByLabelText(/search fields/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /collapse data/i }));
    expect(screen.queryByLabelText(/search fields/i)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /expand data/i }));
    expect(await screen.findByLabelText(/search fields/i)).toBeInTheDocument();
  });

  it("checking a field with no visual selected creates a visual carrying it", async () => {
    // PowerBI's defining Data-pane behavior.
    updateMock.mockResolvedValue(detail);
    getMock.mockResolvedValue({
      ...detail,
      definition: { ...detail.definition, visuals: [] },
    });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");

    await userEvent.click(
      await screen.findByRole("checkbox", { name: "C.REGION" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const [, saved] = updateMock.mock.calls.at(-1)!;
    expect(saved.visuals).toHaveLength(1);
    expect(saved.visuals[0].wells.axis).toEqual(["C.REGION"]);
  });

  it("unchecking removes the field from the selected visual", async () => {
    updateMock.mockResolvedValue(detail);
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: "select v1" }));

    const box = await screen.findByRole("checkbox", { name: "C.REGION" });
    expect(box).toBeChecked();
    await userEvent.click(box);

    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const [, saved] = updateMock.mock.calls.at(-1)!;
    expect(saved.visuals[0].wells.axis).toEqual([]);
  });
});
