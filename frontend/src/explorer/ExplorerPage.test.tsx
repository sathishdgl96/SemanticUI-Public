import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  setOnAuthExpired: vi.fn(),
  ApiError: class extends Error {
    code: string;
    status: number;
    detail?: string | null;
    constructor(code: string, status: number, message: string, detail?: string | null) {
      super(message);
      this.code = code;
      this.status = status;
      this.detail = detail;
      this.name = "ApiError";
    }
  },
}));

vi.mock("../api/composites", () => ({
  listComposites: vi.fn().mockResolvedValue({ composites: [], truncated: false }),
  getComposite: vi.fn(),
}));

vi.mock("../api/reports", () => ({
  createReport: vi.fn(),
}));

import { apiFetch, ApiError } from "../api/client";
import { createReport } from "../api/reports";
import type { SemanticViewDetail } from "../api/types";
import ExplorerPage from "./ExplorerPage";

const apiFetchMock = vi.mocked(apiFetch);
const createReportMock = vi.mocked(createReport);

const ME = { snowflakeUser: "ALICE", snowflakeAccount: "ACME", mode: "dev" };
const VIEW = { name: "My View", database: "DB", schema: "SCH", comment: null };
const DETAIL: SemanticViewDetail = {
  tables: [{ name: "T" }],
  relationships: [],
  dimensions: [{ table: "T", name: "REGION", dataType: "TEXT" }],
  metrics: [{ table: "T", name: "REVENUE", dataType: "NUMBER" }],
  facts: [],
};

function mockRoutes(detailResult: () => Promise<unknown>) {
  apiFetchMock.mockImplementation((...args: unknown[]) => {
    const path = String(args[0]);
    if (path === "/api/me") return Promise.resolve(ME);
    if (path === "/api/semantic-views") return Promise.resolve({ views: [VIEW] });
    if (path.startsWith("/api/semantic-views/")) return detailResult();
    // The explorer now lists saved explores too. Answering it here keeps
    // these tests about the describe path they are named for, rather than
    // about a second failure they never meant to provoke.
    if (path.startsWith("/api/explores")) return Promise.resolve({ explores: [] });
    return Promise.reject(new Error(`unexpected path: ${path}`));
  });
}

function renderPage(
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  path = "/",
) {
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/" element={<ExplorerPage />} />
            <Route path="/login" element={<p>Login page</p>} />
            <Route path="/reports/:id" element={<p>Builder page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  apiFetchMock.mockReset();
  createReportMock.mockReset();
});

describe("ExplorerPage", () => {
  it("shows a retry alert with the error text when describing a view fails", async () => {
    mockRoutes(() =>
      Promise.reject(new ApiError("VIEW_NOT_FOUND", 404, "View DB.SCH.My View not found")),
    );

    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "My View" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("View DB.SCH.My View not found");

    const retry = screen.getByRole("button", { name: /retry/i });
    const callsBefore = apiFetchMock.mock.calls.filter(([p]) =>
      String(p).startsWith("/api/semantic-views/"),
    ).length;

    await userEvent.click(retry);

    await waitFor(() => {
      const callsAfter = apiFetchMock.mock.calls.filter(([p]) =>
        String(p).startsWith("/api/semantic-views/"),
      ).length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it("falls back to a generic message for non-ApiError failures", async () => {
    mockRoutes(() => Promise.reject(new Error("network down")));

    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "My View" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/failed to describe/i);
  });

  it("encodes database, schema, and view name in the describe-view request", async () => {
    mockRoutes(() => Promise.reject(new ApiError("VIEW_ERROR", 500, "boom")));

    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "My View" }));
    await screen.findByRole("alert");

    expect(apiFetchMock).toHaveBeenCalledWith("/api/semantic-views/DB/SCH/My%20View");
  });

  it("disables Add to report until a view is selected and a field is placed", async () => {
    mockRoutes(() => Promise.resolve(DETAIL));
    renderPage();

    expect(screen.getByRole("button", { name: /add to report/i })).toBeDisabled();

    await userEvent.click(await screen.findByRole("button", { name: "My View" }));
    await screen.findByRole("button", { name: /REGION/ });
    expect(screen.getByRole("button", { name: /add to report/i })).toBeDisabled();
  });

  // The hand-off used to build a "bar" whatever was selected, and the catalog
  // requires bar to have Axis >= 1 AND Values >= 1 -- so a lone dimension or a
  // lone measure had to leave the button disabled. It now hands over the type
  // that FITS, which makes both of those perfectly good reports.
  it("offers a lone dimension as a table", async () => {
    mockRoutes(() => Promise.resolve(DETAIL));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "My View" }));
    await userEvent.click(await screen.findByRole("button", { name: /REGION/ }));

    expect(screen.getByRole("button", { name: /add to report/i })).toBeEnabled();
    // The picker shows what is being drawn, so the pressed button is the
    // assertion -- "Table" also appears as the section's summary text.
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("offers a lone measure as a card", async () => {
    mockRoutes(() => Promise.resolve(DETAIL));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "My View" }));
    await userEvent.click(await screen.findByRole("button", { name: /REVENUE/ }));

    expect(screen.getByRole("button", { name: /add to report/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Card" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("hands the report the visual the explore is showing, not always a bar", async () => {
    mockRoutes(() => Promise.resolve(DETAIL));
    createReportMock.mockResolvedValue({ id: "r9" } as never);
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "My View" }));
    await userEvent.click(await screen.findByRole("button", { name: /REGION/ }));
    await userEvent.click(await screen.findByRole("button", { name: /REVENUE/ }));
    // Pick a pie explicitly; the hand-off must carry it rather than reverting
    // to whatever the auto-choice would have been.
    await userEvent.click(screen.getByRole("button", { name: /^Pie$/i }));
    await userEvent.click(screen.getByRole("button", { name: /add to report/i }));

    const definition = createReportMock.mock.calls[0][0];
    const visual = definition.pages[0].visuals[0];
    expect(visual.type).toBe("pie");
    expect(visual.wells).toEqual({ legend: ["T.REGION"], values: ["T.REVENUE"] });
  });

  it("says so when the answer had to be joined through a third entity", async () => {
    // Bridging narrows the result to combinations that occur in the joining
    // entity. That is the only answer the model can give, but it is not the
    // one the user literally asked for -- so it is stated, not assumed.
    apiFetchMock.mockImplementation((...args: unknown[]) => {
      const path = String(args[0]);
      if (path === "/api/me") return Promise.resolve(ME);
      if (path === "/api/semantic-views") return Promise.resolve({ views: [VIEW] });
      if (path.startsWith("/api/semantic-views/")) return Promise.resolve(DETAIL);
      if (path.startsWith("/api/explores")) return Promise.resolve({ explores: [] });
      if (path === "/api/query/semantic") {
        return Promise.resolve({
          columns: [{ name: "REGION", type: "TEXT" }],
          rows: [["EAST"]],
          truncated: false,
          sfqid: "q1",
          sql: "SELECT ...",
          bridgedThrough: "LINEITEMS",
        });
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "My View" }));
    await userEvent.click(await screen.findByRole("button", { name: /REGION/ }));
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));

    expect(await screen.findByText(/joined through LINEITEMS/i)).toBeInTheDocument();
  });

  it("creates a report from the current view and wells, then navigates to its builder", async () => {
    mockRoutes(() => Promise.resolve(DETAIL));
    createReportMock.mockResolvedValue({
      id: "r1",
      name: "My View",
      view: { database: "DB", schema: "SCH", name: "My View" },
      updatedAt: "2026-08-15T00:00:00Z",
      workspaceId: "w0",
      workspaceName: "My reports",
      myRole: "admin" as const, favorite: false, lastViewedAt: null,
      definition: {
        schemaVersion: 3,
        name: "My View",
        view: { database: "DB", schema: "SCH", name: "My View" },
        canvas: { columns: 12, rowHeight: 40 },
        pages: [{ id: "p1", name: "Page 1", visuals: [], filters: [] }],
        filters: [],
        hierarchies: [],
      },
    });
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "My View" }));
    // A dimension alone (or a metric alone) is exactly the combination the
    // server's catalog rejects for a bar visual -- both a dimension and a
    // metric must be placed for this to be a definition the API accepts.
    await userEvent.click(await screen.findByRole("button", { name: /REGION/ }));
    await userEvent.click(await screen.findByRole("button", { name: /REVENUE/ }));

    const addButton = screen.getByRole("button", { name: /add to report/i });
    expect(addButton).toBeEnabled();
    expect(
      screen.queryByText(/add a dimension and a measure to start a report/i),
    ).not.toBeInTheDocument();
    await userEvent.click(addButton);

    await waitFor(() => expect(createReportMock).toHaveBeenCalledTimes(1));
    const [definition] = createReportMock.mock.calls[0];
    expect(definition.view).toEqual({ database: "DB", schema: "SCH", name: "My View" });
    expect(definition.pages[0].visuals).toHaveLength(1);
    expect(definition.pages[0].visuals[0]).toMatchObject({
      type: "bar",
      layout: { x: 0, y: 0, w: 6, h: 6 },
      wells: { axis: ["T.REGION"], legend: [], values: ["T.REVENUE"] },
    });

    await screen.findByText("Builder page");
  });
});

describe("ExplorerPage saved explores", () => {
  const SAVED = {
    id: "e1",
    name: "Revenue by region",
    view: { database: "DB", schema: "SCH", name: "My View" },
    updatedAt: "2026-08-16T00:00:00Z",
    workspaceId: "w0",
    workspaceName: "My reports",
    myRole: "admin" as const, favorite: false, lastViewedAt: null,
    definition: {
      schemaVersion: 1,
      name: "Revenue by region",
      view: { database: "DB", schema: "SCH", name: "My View" },
      dimensions: ["T.REGION"],
      metrics: ["T.REVENUE"],
      filters: [
        { id: "f1", field: "T.REGION", op: "is" as const, values: ["EAST"] },
      ],
      orderBy: [],
    },
  };

  function mockWithExplores(
    explores: unknown[],
    detailResult = () => Promise.resolve(DETAIL),
    opened: unknown = SAVED,
  ) {
    apiFetchMock.mockImplementation((...args: unknown[]) => {
      const path = String(args[0]);
      const init = args[1] as { method?: string } | undefined;
      if (path === "/api/me") return Promise.resolve(ME);
      if (path === "/api/workspaces") {
        return Promise.resolve({
          workspaces: [
            { id: "w0", name: "My reports", kind: "personal", myRole: "admin", memberCount: 1, reportCount: 0 },
            { id: "w1", name: "Team", kind: "shared", myRole: "editor", memberCount: 3, reportCount: 2 },
          ],
        });
      }
      if (path === "/api/semantic-views") return Promise.resolve({ views: [VIEW] });
      if (path.startsWith("/api/semantic-views/")) return detailResult();
      if (path === "/api/explores" && init?.method === "POST") {
        return Promise.resolve(SAVED);
      }
      if (path === "/api/explores") return Promise.resolve({ explores });
      if (path === "/api/explores/e1") return Promise.resolve(opened);
      if (path === "/api/query/semantic") {
        return Promise.resolve({
          columns: [{ name: "REGION", type: "TEXT" }],
          rows: [["EAST"]],
          truncated: false,
          sfqid: null,
          sql: "",
        });
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
  }

  it("says so when there are no saved explores yet", async () => {
    mockWithExplores([]);
    renderPage();
    expect(await screen.findByText(/no saved explores yet/i)).toBeInTheDocument();
  });

  it("lists a saved explore by name alone", async () => {
    // The view used to sit under every row. In a workspace built on one
    // semantic view that is the same word repeated down the list, competing
    // with the only thing that tells the rows apart.
    mockWithExplores([SAVED]);
    renderPage();
    const row = await screen.findByRole("button", { name: /revenue by region/i });
    expect(row).toHaveTextContent("Revenue by region");
    expect(row).not.toHaveTextContent("My View");
  });

  it("saves the current query, filters included", async () => {
    mockWithExplores([]);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "My View" }));
    await userEvent.click(await screen.findByRole("button", { name: /REGION/ }));
    await userEvent.click(await screen.findByRole("button", { name: /REVENUE/ }));

    await userEvent.type(screen.getByLabelText(/explore name/i), "Revenue by region");
    await userEvent.click(screen.getByRole("button", { name: /save as explore/i }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/explores",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const [, init] = apiFetchMock.mock.calls.find(
      ([p, i]) => p === "/api/explores" && (i as { method?: string })?.method === "POST",
    )!;
    const body = JSON.parse((init as { body: string }).body);
    expect(body.definition.dimensions).toEqual(["T.REGION"]);
    expect(body.definition.metrics).toEqual(["T.REVENUE"]);
    expect(body.definition.view.name).toBe("My View");
  });

  it("updates the open explore rather than saving a second copy", async () => {
    mockWithExplores([SAVED]);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Revenue by region/ }));
    await screen.findByDisplayValue("Revenue by region");

    await userEvent.click(screen.getByRole("button", { name: /^save explore$/i }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/explores/e1",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
  });

  it("restores the whole query when reopening, filters included", async () => {
    // Restoring only some of it would show numbers that never belonged to
    // the saved question.
    mockWithExplores([SAVED]);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Revenue by region/ }));

    // The filter came back and describes itself.
    expect(await screen.findByText(/T.REGION is EAST/)).toBeInTheDocument();
    // And the name is loaded, so Save updates rather than duplicates.
    expect(screen.getByLabelText(/explore name/i)).toHaveValue("Revenue by region");
  });

  it("sends the explore's filters with the query", async () => {
    mockWithExplores([SAVED]);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Revenue by region/ }));
    await screen.findByDisplayValue("Revenue by region");

    await userEvent.click(await screen.findByRole("button", { name: /^run$/i }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/query/semantic",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const [, init] = apiFetchMock.mock.calls.find(([p]) => p === "/api/query/semantic")!;
    const body = JSON.parse((init as { body: string }).body);
    expect(body.filters).toEqual([
      { id: "f1", field: "T.REGION", op: "is", values: ["EAST"] },
    ]);
  });

  it("sorts the chart with the table, sends the order to Snowflake, and saves it", async () => {
    // A click on the Data tab's column header used to reorder the table
    // alone: the chart kept the query's order, a rerun lost the sort, and
    // the saved explore never had it.
    mockWithExplores([]);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "My View" }));
    await userEvent.click(await screen.findByRole("button", { name: /REGION/ }));
    await userEvent.click(await screen.findByRole("button", { name: /REVENUE/ }));
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    await screen.findByRole("table");

    // The header in the Data tab.
    await userEvent.click(screen.getByRole("button", { name: /^REGION$/ }));
    expect(screen.getByRole("columnheader", { name: /REGION/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );

    // The next run asks Snowflake for that order.
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    await waitFor(() => {
      const runs = apiFetchMock.mock.calls.filter(([p]) => p === "/api/query/semantic");
      expect(runs).toHaveLength(2);
    });
    const [, lastRun] = apiFetchMock.mock.calls.filter(([p]) => p === "/api/query/semantic").at(-1)!;
    expect(JSON.parse((lastRun as { body: string }).body).orderBy).toEqual([
      { field: "T.REGION", direction: "asc" },
    ]);

    // And the saved explore remembers it.
    await userEvent.type(screen.getByLabelText(/explore name/i), "By region");
    await userEvent.click(screen.getByRole("button", { name: /save as explore/i }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/explores",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const [, init] = apiFetchMock.mock.calls.find(
      ([p, i]) => p === "/api/explores" && (i as { method?: string })?.method === "POST",
    )!;
    expect(JSON.parse((init as { body: string }).body).definition.orderBy).toEqual([
      { field: "T.REGION", direction: "asc" },
    ]);
  });

  it("restores a saved explore's order and shows it on the table", async () => {
    const sorted = {
      ...SAVED,
      definition: {
        ...SAVED.definition,
        orderBy: [{ field: "T.REGION", direction: "desc" as const }],
      },
    };
    mockWithExplores([sorted], undefined, sorted);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Revenue by region/ }));
    await screen.findByDisplayValue("Revenue by region");

    await userEvent.click(await screen.findByRole("button", { name: /^run$/i }));
    await screen.findByRole("table");
    expect(screen.getByRole("columnheader", { name: /REGION/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    const [, init] = apiFetchMock.mock.calls.find(([p]) => p === "/api/query/semantic")!;
    expect(JSON.parse((init as { body: string }).body).orderBy).toEqual([
      { field: "T.REGION", direction: "desc" },
    ]);
  });

  it("drops the filters when the view changes", async () => {
    // They name fields of the old view; the new one has never heard of them.
    mockWithExplores([SAVED]);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Revenue by region/ }));
    await screen.findByText(/T.REGION is EAST/);

    await userEvent.click(screen.getByRole("button", { name: "My View" }));
    await waitFor(() => expect(screen.queryByText(/T.REGION is EAST/)).toBeNull());
  });

  describe("saving into a workspace", () => {
    it("sends the workspace the URL names", async () => {
      // Which is where the workspace's own Create menu sends you: an
      // explore built there must land there rather than in your personal
      // workspace.
      const posted: unknown[] = [];
      apiFetchMock.mockImplementation((...args: unknown[]) => {
        const path = String(args[0]);
        const init = args[1] as { method?: string; body?: string } | undefined;
        if (path === "/api/me") return Promise.resolve(ME);
        if (path === "/api/workspaces") {
          return Promise.resolve({
            workspaces: [
              { id: "w0", name: "My reports", kind: "personal", myRole: "admin", memberCount: 1, reportCount: 0 },
              { id: "w1", name: "Team", kind: "shared", myRole: "editor", memberCount: 3, reportCount: 2 },
            ],
          });
        }
        if (path === "/api/semantic-views") return Promise.resolve({ views: [VIEW] });
        if (path.startsWith("/api/semantic-views/")) return Promise.resolve(DETAIL);
        if (path === "/api/explores" && init?.method === "POST") {
          posted.push(JSON.parse(init.body ?? "{}"));
          return Promise.resolve(SAVED);
        }
        if (path === "/api/explores") return Promise.resolve({ explores: [] });
        if (path === "/api/query/semantic") {
          return Promise.resolve({
            columns: [{ name: "REGION", type: "TEXT" }],
            rows: [["EAST"]],
            truncated: false,
            sfqid: null,
            sql: "",
          });
        }
        return Promise.reject(new Error(`unexpected path: ${path}`));
      });

      renderPage(undefined, "/?workspace=w1");
      // The fields only exist once a view is chosen.
      await userEvent.click(await screen.findByRole("button", { name: "My View" }));
      await userEvent.click(await screen.findByRole("button", { name: /REGION/ }));
      await userEvent.type(screen.getByLabelText(/explore name/i), "Regions");
      await userEvent.click(screen.getByRole("button", { name: /save as explore/i }));

      await waitFor(() => expect(posted).toHaveLength(1));
      expect((posted[0] as { workspaceId?: string }).workspaceId).toBe("w1");
    });

    it("offers the workspaces you can save into", async () => {
      mockWithExplores([]);
      renderPage(undefined, "/?workspace=w1");
      const picker = await screen.findByRole("combobox", { name: /save into/i });
      expect(picker).toHaveValue("w1");
      expect(within(picker).getByRole("option", { name: "Team" })).toBeInTheDocument();
    });
  });
});


describe("exploring a model", () => {
  it("sends every request for the model to the model's endpoints", async () => {
    // describe, query and VALUES all have to move together. Values was
    // built from three empty strings once, and the filter picker asked
    // /api/semantic-views///Untitled model/values forever.
    const { listComposites } = await import("../api/composites");
    vi.mocked(listComposites).mockResolvedValue({
      composites: [
        {
          id: "m1",
          name: "Customer 360",
          workspaceId: "w0",
          workspaceName: "Team",
          myRole: "admin",
          memberCount: 2,
          updatedAt: "2026-08-20T10:00:00Z",
          createdBy: "A_SMITH",
          favorite: false,
          lastViewedAt: null,
        },
      ],
      truncated: false,
    } as never);

    apiFetchMock.mockImplementation((...args: unknown[]) => {
      const path = String(args[0]);
      if (path === "/api/me") return Promise.resolve(ME);
      if (path === "/api/semantic-views") return Promise.resolve({ views: [] });
      if (path.startsWith("/api/explores")) return Promise.resolve({ explores: [] });
      if (path.startsWith("/api/composites/m1/describe")) {
        return Promise.resolve({
          tables: [],
          relationships: [],
          dimensions: [{ table: "Customer 360", name: "Customer", dataType: "TEXT" }],
          metrics: [],
          facts: [],
        });
      }
      if (path.startsWith("/api/composites/m1/values")) {
        return Promise.resolve({ values: ["ACME"], truncated: false });
      }
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });

    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Customer 360/ }));

    // The field list came from the model.
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/composites/m1/describe"),
    );
    // And nothing asked the semantic-view endpoints for it.
    const strayed = apiFetchMock.mock.calls
      .map(([p]) => String(p))
      .filter((p) => p.startsWith("/api/semantic-views/"));
    expect(strayed).toEqual([]);
  });
});

describe("models in the source list", () => {
  it("reads as another thing you can pick, not a button in a tree", async () => {
    const { listComposites } = await import("../api/composites");
    vi.mocked(listComposites).mockResolvedValue({
      composites: [
        {
          id: "m1",
          name: "Customer 360",
          workspaceId: "w0",
          workspaceName: "Team",
          myRole: "admin",
          memberCount: 2,
          updatedAt: "2026-08-21T10:00:00Z",
          createdBy: "A_SMITH",
          favorite: false,
          lastViewedAt: null,
        },
      ],
      truncated: false,
    } as never);
    mockRoutes(() => Promise.resolve(DETAIL));

    renderPage();
    const row = await screen.findByRole("button", { name: /Customer 360/ });
    // The same class the semantic-view rows carry, so the two lists read
    // as one control rather than a list and a stray button.
    expect(row).toHaveClass("view-item");
  });

  it("does not offer a model with nothing mapped yet", async () => {
    const { listComposites } = await import("../api/composites");
    vi.mocked(listComposites).mockResolvedValue({
      composites: [
        {
          id: "m2",
          name: "Empty",
          workspaceId: "w0",
          workspaceName: "Team",
          myRole: "admin",
          memberCount: 0,
          updatedAt: "2026-08-21T10:00:00Z",
          createdBy: "A_SMITH",
          favorite: false,
          lastViewedAt: null,
        },
      ],
      truncated: false,
    } as never);
    mockRoutes(() => Promise.resolve(DETAIL));

    renderPage();
    await screen.findByRole("button", { name: "My View" });
    expect(screen.queryByRole("button", { name: /Empty/ })).toBeNull();
  });
});
