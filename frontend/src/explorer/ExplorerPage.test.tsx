import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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

function renderPage(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/"]}>
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

  // The hand-off always builds a "bar" visual (see the comment above
  // `addToReport` in ExplorerPage), and the catalog requires bar to have
  // Axis >= 1 AND Values >= 1. Placing only a dimension is the most natural
  // first action in the explorer, so this is exactly the case that must stay
  // disabled -- enabling it would let the user submit a definition the
  // server rejects with a 400 naming an internal visual id.
  it("stays disabled with a hint when only a dimension is placed", async () => {
    mockRoutes(() => Promise.resolve(DETAIL));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "My View" }));
    await userEvent.click(await screen.findByRole("button", { name: /REGION/ }));

    expect(screen.getByRole("button", { name: /add to report/i })).toBeDisabled();
    expect(
      screen.getByText(/add a dimension and a measure to start a report/i),
    ).toBeInTheDocument();
  });

  it("stays disabled with a hint when only a metric is placed", async () => {
    mockRoutes(() => Promise.resolve(DETAIL));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "My View" }));
    await userEvent.click(await screen.findByRole("button", { name: /REVENUE/ }));

    expect(screen.getByRole("button", { name: /add to report/i })).toBeDisabled();
    expect(
      screen.getByText(/add a dimension and a measure to start a report/i),
    ).toBeInTheDocument();
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
      myRole: "admin" as const,
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
    myRole: "admin" as const,
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

  function mockWithExplores(explores: unknown[], detailResult = () => Promise.resolve(DETAIL)) {
    apiFetchMock.mockImplementation((...args: unknown[]) => {
      const path = String(args[0]);
      const init = args[1] as { method?: string } | undefined;
      if (path === "/api/me") return Promise.resolve(ME);
      if (path === "/api/semantic-views") return Promise.resolve({ views: [VIEW] });
      if (path.startsWith("/api/semantic-views/")) return detailResult();
      if (path === "/api/explores" && init?.method === "POST") {
        return Promise.resolve(SAVED);
      }
      if (path === "/api/explores") return Promise.resolve({ explores });
      if (path === "/api/explores/e1") return Promise.resolve(SAVED);
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

  it("drops the filters when the view changes", async () => {
    // They name fields of the old view; the new one has never heard of them.
    mockWithExplores([SAVED]);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Revenue by region/ }));
    await screen.findByText(/T.REGION is EAST/);

    await userEvent.click(screen.getByRole("button", { name: "My View" }));
    await waitFor(() => expect(screen.queryByText(/T.REGION is EAST/)).toBeNull());
  });
});
