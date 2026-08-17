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
    factRefs,
  }: {
    visuals: { id: string }[];
    onSelect: (id: string) => void;
    onDrill?: (id: string, next: unknown) => void;
    onCrossFilter?: (next: unknown) => void;
    factRefs?: string[];
  }) => (
    <div>
      {/* Surfaced so a test can prove the builder actually hands the canvas
          the fact list. Without it every raw fact goes out as a governed
          metric and the API rejects the query -- a wiring gap the component
          tests on either side both missed. */}
      <span data-testid="canvas-fact-refs">{(factRefs ?? []).join(",")}</span>
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
    schemaVersion: 3,
    name: "Sales overview",
    view: { database: "ANALYTICS", schema: "PUBLIC", name: "SALES" },
    canvas: { columns: 12, rowHeight: 40 },
    pages: [
      {
        id: "p1",
        name: "Page 1",
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
    schemaVersion: 3,
    name: "Marketing overview",
    view: { database: "ANALYTICS", schema: "PUBLIC", name: "SALES" },
    canvas: { columns: 12, rowHeight: 40 },
    pages: [{ id: "p1", name: "Page 1", visuals: [], filters: [] }],
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
    expect(savedDefinition.pages[0].visuals[0].wells.axis).toEqual([]);
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
        schemaVersion: 3,
        name: "Untitled report",
        view: { database: "", schema: "", name: "" },
        canvas: { columns: 12, rowHeight: 40 },
        pages: [{ id: "p1", name: "Page 1", visuals: [], filters: [] }],
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

  it("SAVES the view the moment it is picked, not when Save is next pressed", async () => {
    // Everything server-side -- Chat, Excel, Connect -- reads the report's
    // STORED view. Binding used to change local state only, so a report that
    // plainly showed a view on screen was still unbound to the API, and the
    // only way through was a Save nothing asked for.
    const unbound = {
      ...detail,
      view: { database: "", schema: "", name: "" },
      definition: {
        ...detail.definition,
        view: { database: "", schema: "", name: "" },
      },
    };
    getMock.mockReset();
    getMock.mockResolvedValue(unbound);
    updateMock.mockImplementation((_id: string, definition: unknown) =>
      Promise.resolve({ ...unbound, definition } as never),
    );
    apiFetchMock.mockResolvedValue({
      views: [{ database: "ANALYTICS", schema: "PUBLIC", name: "SALES", comment: null }],
    } as never);

    renderBuilder();
    await userEvent.click(await screen.findByRole("button", { name: "SALES" }));

    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const [, saved] = updateMock.mock.calls[0] as [string, { view: unknown }];
    expect(saved.view).toEqual({
      database: "ANALYTICS",
      schema: "PUBLIC",
      name: "SALES",
    });
  });

  it("does not offer the picker to a viewer, who could not save it anyway", async () => {
    getMock.mockReset();
    getMock.mockResolvedValue({
      ...detail,
      myRole: "viewer" as const,
      view: { database: "", schema: "", name: "" },
      definition: {
        ...detail.definition,
        view: { database: "", schema: "", name: "" },
      },
    });
    renderBuilder();
    expect(await screen.findByRole("alert")).toHaveTextContent(/only an editor/i);
  });

  it("carries the fields across a type change instead of emptying the visual", async () => {
    // The whole point of the kind-based remap: bar's Axis dimension belongs
    // in pie's Legend, even though the wells have different names.
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: "select v1" }));
    await userEvent.click(screen.getByRole("button", { name: /^pie$/i }));

    const legend = await screen.findByRole("region", { name: "Legend" });
    expect(within(legend).getByText("C.REGION")).toBeInTheDocument();
    const values = screen.getByRole("region", { name: "Values" });
    expect(within(values).getByText("A.REV")).toBeInTheDocument();
    expect(screen.queryByText(/has no room for/i)).not.toBeInTheDocument();
  });

  it("says what a narrower type had no room for", async () => {
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: "select v1" }));
    // A card has one metric well and no dimension well at all, so the
    // dimension genuinely has nowhere to go.
    await userEvent.click(screen.getByRole("button", { name: /^card$/i }));
    expect(await screen.findByText(/has no room for C\.REGION/i)).toBeInTheDocument();
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
    // Rows now show the bare field name (the pane groups by table); the
    // dataType rides in the accessible name, hence the loose match.
    const row = await screen.findByRole("button", { name: /PROFIT/i });
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

  it("adding a page filter marks the report dirty and saves it on that page", async () => {
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
    expect(saved.pages[0].filters).toEqual([
      expect.objectContaining({ field: "C.REGION", op: "is", values: [] }),
    ]);
    // The page scope is not the all-pages scope.
    expect(saved.filters).toEqual([]);
  });

  it("adding an all-pages filter saves it at report scope", async () => {
    updateMock.mockResolvedValue(detail);
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");

    await userEvent.selectOptions(
      await screen.findByLabelText(/add a filter on all pages/i),
      "C.REGION",
    );
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const [, saved] = updateMock.mock.calls[0];
    expect(saved.filters).toEqual([
      expect.objectContaining({ field: "C.REGION", op: "is", values: [] }),
    ]);
    expect(saved.pages[0].filters).toEqual([]);
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
    expect(saved.pages[0].visuals[0].wells.axis[0]).toMatch(/^hierarchy:/);
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

  it("keeps the other ways to connect one click from the Excel button", async () => {
    // One control now, because it is one thing: the workbook carries the
    // numbers AND the connection. The caret is where the fallbacks went --
    // a .odc, the raw SQL -- rather than a second top-level button implying
    // a second feature.
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await userEvent.click(
      screen.getByRole("button", { name: /other ways to connect/i }),
    );
    expect(
      await screen.findByRole("region", { name: /connect from excel/i }),
    ).toBeInTheDocument();
  });

  it("offers both to a viewer, since exporting and copying SQL are reading", async () => {
    getMock.mockResolvedValue({ ...detail, myRole: "viewer" as const });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    expect(screen.getByRole("button", { name: /^excel$/i })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /other ways to connect/i }),
    ).toBeEnabled();
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
      definition: {
        ...detail.definition,
        pages: [{ id: "p1", name: "Page 1", visuals: [], filters: [] }],
      },
    });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");

    await userEvent.click(
      await screen.findByRole("checkbox", { name: "C.REGION" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const [, saved] = updateMock.mock.calls.at(-1)!;
    expect(saved.pages[0].visuals).toHaveLength(1);
    expect(saved.pages[0].visuals[0].wells.axis).toEqual(["C.REGION"]);
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
    expect(saved.pages[0].visuals[0].wells.axis).toEqual([]);
  });
});

describe("BuilderPage pages", () => {
  // Two pages, each holding one visual, so "which page am I on" is visible
  // from the canvas alone.
  const twoPages = {
    ...detail,
    definition: {
      ...detail.definition,
      pages: [
        detail.definition.pages[0],
        {
          id: "p2",
          name: "Costs",
          visuals: [
            {
              id: "v2",
              type: "bar",
              title: "Cost tile",
              layout: { x: 0, y: 0, w: 6, h: 6 },
              wells: { axis: ["C.REGION"], legend: [], values: ["A.COST"] },
              options: {},
              filters: [],
            },
          ],
          filters: [],
        },
      ],
    },
  };

  it("shows only the active page's visuals, and switches with the tab", async () => {
    getMock.mockResolvedValue(twoPages);
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");

    expect(screen.getByRole("button", { name: "select v1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "select v2" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Costs" }));
    expect(await screen.findByRole("button", { name: "select v2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "select v1" })).toBeNull();
  });

  it("clears the selection when switching pages", async () => {
    getMock.mockResolvedValue(twoPages);
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");

    await userEvent.click(screen.getByRole("button", { name: "select v1" }));
    expect(await screen.findByRole("region", { name: "Axis" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Costs" }));
    // A selection belongs to the page it was made on.
    expect(await screen.findByText(/select a visual/i)).toBeInTheDocument();
  });

  it("adds a page and puts a newly checked field's visual on it", async () => {
    updateMock.mockResolvedValue(detail);
    getMock.mockResolvedValue(twoPages);
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");

    await userEvent.click(screen.getByRole("button", { name: /new page/i }));
    expect(await screen.findByRole("button", { name: "Page 3" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await userEvent.click(await screen.findByRole("checkbox", { name: "A.REV" }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());

    const [, saved] = updateMock.mock.calls.at(-1)!;
    expect(saved.pages).toHaveLength(3);
    // The new visual landed on the new page, and nowhere else.
    expect(saved.pages[2].visuals).toHaveLength(1);
    expect(saved.pages[0].visuals).toHaveLength(1);
    expect(saved.pages[1].visuals).toHaveLength(1);
  });

  it("keeps a page filter on its own page", async () => {
    updateMock.mockResolvedValue(detail);
    getMock.mockResolvedValue(twoPages);
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");

    await userEvent.click(screen.getByRole("button", { name: "Costs" }));
    await userEvent.selectOptions(
      await screen.findByLabelText(/add a filter on this page/i),
      "C.REGION",
    );
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());

    const [, saved] = updateMock.mock.calls.at(-1)!;
    expect(saved.pages[1].filters).toHaveLength(1);
    expect(saved.pages[0].filters).toEqual([]);
  });

  it("deletes a page and falls back to the first one", async () => {
    updateMock.mockResolvedValue(detail);
    getMock.mockResolvedValue(twoPages);
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");

    await userEvent.click(screen.getByRole("button", { name: "Costs" }));
    await userEvent.click(screen.getByRole("button", { name: /page actions for costs/i }));
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await userEvent.click(screen.getByRole("button", { name: /delete page/i }));

    expect(screen.queryByRole("button", { name: "Costs" })).toBeNull();
    expect(await screen.findByRole("button", { name: "select v1" })).toBeInTheDocument();
  });

  it("duplicates a page with fresh visual ids", async () => {
    updateMock.mockResolvedValue(detail);
    getMock.mockResolvedValue(twoPages);
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");

    await userEvent.click(screen.getByRole("button", { name: /page actions for page 1/i }));
    await userEvent.click(screen.getByRole("button", { name: /duplicate/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());

    const [, saved] = updateMock.mock.calls.at(-1)!;
    expect(saved.pages.map((p: { name: string }) => p.name)).toEqual([
      "Page 1",
      "Duplicate of Page 1",
      "Costs",
    ]);
    // Visual ids are unique across the whole report, so the copy minted a
    // new one rather than colliding with its source.
    const ids = saved.pages.flatMap((p: { visuals: { id: string }[] }) =>
      p.visuals.map((v) => v.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("BuilderPage fact wiring", () => {
  it("hands the canvas the view's fact refs", async () => {
    // The tile is what turns a fact into an aggregation. If the list stops
    // here, every fact is sent as a metric the view does not define and the
    // query 400s -- which is exactly what happened.
    apiFetchMock.mockResolvedValue({
      tables: [],
      relationships: [],
      dimensions: [{ table: "C", name: "REGION", dataType: "TEXT" }],
      metrics: [{ table: "O", name: "REVENUE", dataType: "NUMBER" }],
      facts: [{ table: "O", name: "QUANTITY", dataType: "NUMBER" }],
    });
    renderBuilder();
    await screen.findByDisplayValue("Sales overview");
    await waitFor(() =>
      expect(screen.getByTestId("canvas-fact-refs")).toHaveTextContent("O.QUANTITY"),
    );
  });
});
