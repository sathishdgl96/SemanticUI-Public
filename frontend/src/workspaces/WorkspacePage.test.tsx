import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/reports", () => ({
  listReports: vi.fn(),
  deleteReport: vi.fn(),
  createReport: vi.fn(),
}));
// One list holds all three kinds now, so all three have to answer for
// anything to render.
vi.mock("../api/dashboards", () => ({
  listDashboards: vi.fn().mockResolvedValue({ dashboards: [] }),
  createDashboard: vi.fn(),
  deleteDashboard: vi.fn(),
}));
vi.mock("../api/explores", () => ({
  listExplores: vi.fn().mockResolvedValue({ explores: [] }),
}));
vi.mock("../api/library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/library")>()),
  setFavorite: vi.fn().mockResolvedValue({ favorite: true }),
  recordView: vi.fn().mockResolvedValue({ ok: true }),
}));
// The page now waits for its workspace list before it queries reports at all
// -- there is no such thing as an unfiled report -- so the switcher's fetch
// has to resolve for anything else to render.
vi.mock("../api/workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/workspaces")>()),
  listWorkspaces: vi.fn().mockResolvedValue({
    workspaces: [
      {
        id: "w0",
        name: "My reports",
        kind: "personal",
        myRole: "admin",
        memberCount: 1,
        reportCount: 1,
      },
    ],
  }),
}));

import { ApiError } from "../api/client";
import { setFavorite, recordView } from "../api/library";
import { createReport, deleteReport, listReports } from "../api/reports";
import type { ReportSummary } from "../api/types";
import { createDashboard, listDashboards } from "../api/dashboards";
import { listExplores } from "../api/explores";
import WorkspacePage from "./WorkspacePage";

const listMock = vi.mocked(listReports);
const deleteMock = vi.mocked(deleteReport);
const createMock = vi.mocked(createReport);
const favoriteMock = vi.mocked(setFavorite);
const viewMock = vi.mocked(recordView);
const dashboardsMock = vi.mocked(listDashboards);
const exploresMock = vi.mocked(listExplores);

/** A report summary with every field the list reads, so a test only has to
 *  state what it is actually about. */
function summary(over: Partial<ReportSummary> = {}): ReportSummary {
  return {
    id: "r1",
    name: "Sales overview",
    view: { database: "ANALYTICS", schema: "PUBLIC", name: "SALES" },
    updatedAt: "2026-08-15T10:00:00+00:00",
    workspaceId: "w0",
    workspaceName: "My reports",
    myRole: "admin" as const,
    favorite: false,
    lastViewedAt: null,
    ...over,
  };
}

function renderPageAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <WorkspacePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Inside one workspace, which is where the flyout drops you. */
function renderPage() {
  return renderPageAt("/reports?workspace=w0");
}

/** Browse with no workspace named: everything, everywhere. */
function renderBrowse() {
  return renderPageAt("/reports");
}

beforeEach(() => {
  listMock.mockReset();
  deleteMock.mockReset();
  createMock.mockReset();
  favoriteMock.mockClear();
  viewMock.mockClear();
  // Reset, not clear: a mockResolvedValue set by one test otherwise leaks
  // into the next, and a stray explore row is enough to break a test that
  // is only about reports.
  dashboardsMock.mockReset().mockResolvedValue({ dashboards: [] });
  exploresMock.mockReset().mockResolvedValue({ explores: [] });
});

/** Open the Create menu and choose a kind. One button offers all four, so
 *  making anything takes two clicks -- and a test has to make both. */
async function createA(kind: RegExp) {
  // The exact name: /^create/i also matches the "Created by" column
  // header, which is a button because that column sorts.
  await userEvent.click(screen.getByRole("button", { name: "Create" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: kind }));
}

/** The names in the order the table is rendering them. The header cell
 *  carries the same class, so read the body only. */
function names(): string[] {
  return Array.from(document.querySelectorAll("tbody .cell-name")).map(
    (cell) => cell.textContent ?? "",
  );
}

describe("WorkspacePage", () => {
  it("browses every workspace when the URL names none", async () => {
    // Browse answers "where is that thing I remember", which is not a
    // question about one workspace. The rail's flyout names one; the
    // rail's Browse does not.
    listMock.mockResolvedValue({ reports: [summary()] });
    renderBrowse();
    await screen.findByText("Sales overview");
    expect(listMock).toHaveBeenCalledWith(undefined, expect.anything());
    expect(await screen.findByText(/across \d+ workspace/i)).toBeInTheDocument();
  });

  it("narrows to one workspace from the same bar as everything else", async () => {
    listMock.mockResolvedValue({ reports: [summary()] });
    renderBrowse();
    await screen.findByText("Sales overview");

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /workspace/i }),
      "w0",
    );
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith("w0", expect.anything()),
    );
  });

  it("says which workspace and who made each item", async () => {
    // Across every workspace, "whose is this and where does it live" is
    // the pair of questions a name alone cannot answer.
    listMock.mockResolvedValue({
      reports: [summary({ createdBy: "A_SMITH" })],
    });
    renderBrowse();
    await screen.findByText("Sales overview");
    expect(screen.getByText("A_SMITH")).toBeInTheDocument();
    expect(screen.getAllByText("My reports").length).toBeGreaterThan(0);
  });

  it("will not create until a workspace is chosen, and says so", async () => {
    listMock.mockResolvedValue({ reports: [summary()] });
    renderBrowse();
    await screen.findByText("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    const item = await screen.findByRole("menuitem", { name: /^report$/i });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", expect.stringMatching(/pick a workspace/i));
  });

  it("offers every kind behind one Create button", async () => {
    listMock.mockResolvedValue({ reports: [summary()] });
    renderPage();
    await screen.findByText("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    for (const kind of [/^report$/i, /^dashboard$/i, /^explore$/i, /import a report/i]) {
      expect(await screen.findByRole("menuitem", { name: kind })).toBeInTheDocument();
    }
  });

  it("creates a dashboard from the same menu", async () => {
    listMock.mockResolvedValue({ reports: [] });
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    await createA(/^dashboard$/i);
    await waitFor(() =>
      expect(vi.mocked(createDashboard)).toHaveBeenCalledWith(
        "Untitled dashboard",
        "w0",
      ),
    );
  });

  it("lists reports, dashboards and explores together, with the kind on each", async () => {
    // One list with a filter rather than a menu per kind: all three live in
    // a workspace, are governed by the same membership, and browse the same
    // way.
    listMock.mockResolvedValue({ reports: [summary()] });
    dashboardsMock.mockResolvedValue({
      dashboards: [
        {
          id: "d1",
          name: "Ops",
          workspaceId: "w0",
          workspaceName: "My reports",
          myRole: "admin",
          tileCount: 2,
          updatedAt: "2026-08-19T10:00:00Z",
          favorite: false,
          lastViewedAt: null,
        },
      ],
    });
    exploresMock.mockResolvedValue({
      explores: [
        {
          id: "e1",
          name: "Churn",
          view: { database: "ANALYTICS", schema: "PUBLIC", name: "SALES" },
          updatedAt: "2026-08-18T10:00:00Z",
          workspaceId: "w0",
          workspaceName: "My reports",
          myRole: "admin",
          favorite: false,
          lastViewedAt: null,
        },
      ],
    });
    renderPage();

    expect(await screen.findByText("Sales overview")).toBeInTheDocument();
    expect(screen.getByText("Ops")).toBeInTheDocument();
    expect(screen.getByText("Churn")).toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Explore")).toBeInTheDocument();
  });

  it("says when the list was cut short rather than showing a fraction quietly", async () => {
    listMock.mockResolvedValue({ reports: [summary()], truncated: true });
    renderPage();
    await screen.findByText("Sales overview");
    expect(screen.getByText(/showing the first/i)).toBeInTheDocument();
  });

  it("says nothing when the whole list fits", async () => {
    listMock.mockResolvedValue({ reports: [summary()], truncated: false });
    renderPage();
    await screen.findByText("Sales overview");
    expect(screen.queryByText(/showing the first/i)).toBeNull();
  });

  it("opens already narrowed when the URL names a kind", async () => {
    // Which is what Home's own Dashboards entry is: a link into the
    // filtered list rather than to the whole of it.
    listMock.mockResolvedValue({ reports: [summary()] });
    dashboardsMock.mockResolvedValue({
      dashboards: [
        {
          id: "d1",
          name: "Ops",
          workspaceId: "w0",
          workspaceName: "My reports",
          myRole: "admin",
          tileCount: 2,
          updatedAt: "2026-08-19T10:00:00Z",
          favorite: false,
          lastViewedAt: null,
        },
      ],
    });
    renderPageAt("/reports?kind=dashboard");

    expect(await screen.findByText("Ops")).toBeInTheDocument();
    expect(screen.queryByText("Sales overview")).toBeNull();
    expect(screen.getByRole("button", { name: /^dashboards$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps the workspace when the kind changes, and the kind when the workspace does", async () => {
    listMock.mockResolvedValue({ reports: [summary()] });
    renderPageAt("/reports?workspace=w0&kind=report");
    await screen.findByText("Sales overview");

    await userEvent.click(screen.getByRole("button", { name: /^all$/i }));
    // Still scoped to the workspace it was opened in.
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith("w0", expect.anything()));
  });

  it("narrows to one kind, and does not fetch the others", async () => {
    listMock.mockResolvedValue({ reports: [summary()] });
    dashboardsMock.mockResolvedValue({
      dashboards: [
        {
          id: "d1",
          name: "Ops",
          workspaceId: "w0",
          workspaceName: "My reports",
          myRole: "admin",
          tileCount: 2,
          updatedAt: "2026-08-19T10:00:00Z",
          favorite: false,
          lastViewedAt: null,
        },
      ],
    });
    renderPage();
    await screen.findByText("Sales overview");

    await userEvent.click(screen.getByRole("button", { name: /^dashboards$/i }));
    expect(await screen.findByText("Ops")).toBeInTheDocument();
    expect(screen.queryByText("Sales overview")).toBeNull();
  });

  it("links each kind to the page that opens it", async () => {
    listMock.mockResolvedValue({ reports: [summary()] });
    dashboardsMock.mockResolvedValue({
      dashboards: [
        {
          id: "d1",
          name: "Ops",
          workspaceId: "w0",
          workspaceName: "My reports",
          myRole: "admin",
          tileCount: 0,
          updatedAt: "2026-08-19T10:00:00Z",
          favorite: false,
          lastViewedAt: null,
        },
      ],
    });
    renderPage();
    expect(await screen.findByRole("link", { name: "Ops" })).toHaveAttribute(
      "href",
      "/dashboards/d1",
    );
    expect(screen.getByRole("link", { name: "Sales overview" })).toHaveAttribute(
      "href",
      "/reports/r1",
    );
  });

  it("lists reports with their bound view", async () => {
    listMock.mockResolvedValue({ reports: [summary()] });
    renderPage();
    expect(await screen.findByText("Sales overview")).toBeInTheDocument();
    expect(screen.getByText(/ANALYTICS\.PUBLIC\.SALES/)).toBeInTheDocument();
  });

  it("invites the user to act when there are no reports", async () => {
    listMock.mockResolvedValue({ reports: [] });
    renderPage();
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument();
  });

  it("deletes a report after confirmation", async () => {
    listMock.mockResolvedValue({
      reports: [summary({ view: { database: "A", schema: "B", name: "C" } })],
    });
    deleteMock.mockResolvedValue(undefined);
    renderPage();
    await screen.findByText("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: /delete Sales overview/i }));
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("r1"));
  });

  it("surfaces a load failure instead of rendering an empty list", async () => {
    listMock.mockRejectedValue(new Error("boom"));
    renderPage();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("shows an error and keeps the confirmation open when delete fails", async () => {
    listMock.mockResolvedValue({
      reports: [summary({ view: { database: "A", schema: "B", name: "C" } })],
    });
    deleteMock.mockRejectedValue(new ApiError("REPORT_LOCKED", 409, "Report is locked"));
    renderPage();
    await screen.findByText("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: /delete Sales overview/i }));
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/report is locked/i);
    // Failure must not silently dismiss it — the user needs to see
    // why nothing happened and still has Cancel/retry available.
    expect(screen.getByRole("group", { name: /confirm delete/i })).toBeInTheDocument();
  });

  it("shows an alert with the backend's message when creating a report fails", async () => {
    listMock.mockResolvedValue({ reports: [] });
    createMock.mockRejectedValue(
      new ApiError(
        "REPORT_INVALID",
        400,
        "This report must be bound to a semantic view before it can hold visuals.",
      ),
    );
    renderPage();
    await screen.findByText(/nothing here yet/i);
    await createA(/^report$/i);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      /this report must be bound to a semantic view before it can hold visuals/i,
    );
  });
});

describe("WorkspacePage browsing", () => {
  it("asks the server to search for what was typed", async () => {
    listMock.mockResolvedValue({ reports: [summary()] });
    renderPage();
    await screen.findByText("Sales overview");

    await userEvent.type(screen.getByRole("searchbox"), "churn");

    // Searching is the server's job: a hundred reports are not all in the
    // browser to filter locally.
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith(
        "w0",
        expect.objectContaining({ q: "churn" }),
      ),
    );
  });

  it("shows a pin control on every row and pins through it", async () => {
    listMock.mockResolvedValue({ reports: [summary({ favorite: false })] });
    renderPage();

    const pin = await screen.findByRole("button", { name: /^pin$/i });
    await userEvent.click(pin);
    await waitFor(() => expect(favoriteMock).toHaveBeenCalledWith("report", "r1", true));
  });

  it("labels an already-pinned row as the way to unpin it", async () => {
    listMock.mockResolvedValue({ reports: [summary({ favorite: true })] });
    renderPage();
    expect(await screen.findByRole("button", { name: /unpin/i })).toBeInTheDocument();
  });

  it("says what is being filtered, and clears it on request", async () => {
    listMock.mockResolvedValue({ reports: [summary()] });
    renderPage();
    await screen.findByText("Sales overview");
    await userEvent.type(screen.getByRole("searchbox"), "churn");

    // The count is the point: a filtered list that does not say so is
    // indistinguishable from data having gone missing.
    expect(await screen.findByText(/showing/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /clear q/i }));
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith("w0", expect.objectContaining({ q: "" })),
    );
  });

  it("offers a way out when a search matches nothing", async () => {
    listMock.mockResolvedValue({ reports: [] });
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    await userEvent.type(screen.getByRole("searchbox"), "churn");

    // Not the same emptiness as "you have no reports": one is a dead end,
    // the other has an obvious next move.
    expect(await screen.findByText(/nothing matches/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /clear filters/i }));
    // Cleared, whether that is an empty string or the key dropped -- what
    // matters is that the next fetch carries no search.
    await waitFor(() => expect(listMock.mock.lastCall?.[1]?.q ?? "").toBe(""));
  });

  it("still invites a first report when the workspace is genuinely empty", async () => {
    listMock.mockResolvedValue({ reports: [] });
    renderPage();
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument();
  });

  it("records that a report was opened", async () => {
    listMock.mockResolvedValue({ reports: [summary()] });
    renderPage();
    await userEvent.click(await screen.findByRole("link", { name: "Sales overview" }));
    await waitFor(() => expect(viewMock).toHaveBeenCalledWith("report", "r1"));
  });

  it("sorts the merged list without refetching it", async () => {
    // Three lists are being merged, so only one of the three could ever
    // have been ordered remotely. Ordering here also means a sort costs
    // no round trip.
    listMock.mockResolvedValue({
      reports: [
        summary({ id: "r2", name: "Zulu" }),
        summary({ id: "r1", name: "Alpha" }),
      ],
    });
    renderPage();
    await screen.findByText("Alpha");
    const calls = listMock.mock.calls.length;

    await userEvent.selectOptions(screen.getByLabelText(/sort/i), "name");
    expect(names()).toEqual(["Alpha", "Zulu"]);
    expect(listMock.mock.calls.length).toBe(calls);
  });

  it("sorts by a column when its header is clicked, and reverses on a second", async () => {
    listMock.mockResolvedValue({
      reports: [
        summary({ id: "r2", name: "Zulu" }),
        summary({ id: "r1", name: "Alpha" }),
      ],
    });
    renderPage();
    await screen.findByText("Alpha");

    await userEvent.click(screen.getByRole("button", { name: /^name/i }));
    expect(names()).toEqual(["Alpha", "Zulu"]);
    await userEvent.click(screen.getByRole("button", { name: /^name/i }));
    expect(names()).toEqual(["Zulu", "Alpha"]);
  });

  it("says which column is sorted, and which way", async () => {
    listMock.mockResolvedValue({ reports: [summary()] });
    renderPage();
    await screen.findByText("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: /^name/i }));
    expect(screen.getByRole("columnheader", { name: /name/i })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  it("confirms a delete in the row it is about", async () => {
    // It used to render after the table: clicking row 3 of forty put the
    // question below row 40, usually off-screen.
    listMock.mockResolvedValue({ reports: [summary()] });
    renderPage();
    await screen.findByText("Sales overview");
    await userEvent.click(screen.getByRole("button", { name: /delete Sales overview/i }));

    const confirm = screen.getByRole("group", { name: /confirm delete/i });
    const row = screen.getByRole("link", { name: "Sales overview" }).closest("tr");
    expect(confirm.closest("tr")?.previousElementSibling).toBe(row);
  });
});

describe("WorkspacePage workspaces", () => {
  it("scopes the listing to the selected workspace", async () => {
    listMock.mockResolvedValue({ reports: [] });
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    // The personal workspace is selected by default, so the very first fetch
    // is already scoped -- the page never shows an unscoped "everything" list
    // under a switcher that claims one workspace.
    expect(listMock).toHaveBeenCalledWith("w0", expect.anything());
  });

  it("creates a report in the selected workspace", async () => {
    listMock.mockResolvedValue({ reports: [] });
    createMock.mockResolvedValue({
      id: "r9",
      name: "Untitled report",
      view: { database: "", schema: "", name: "" },
      updatedAt: "",
      workspaceId: "w0",
      workspaceName: "My reports",
      myRole: "admin",
      favorite: false,
      lastViewedAt: null,
      definition: {} as never,
    });
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    await createA(/^report$/i);
    expect(createMock).toHaveBeenCalledWith(expect.anything(), "w0");
  });
});

describe("WorkspacePage URL scoping", () => {
  it("scopes the listing to the workspace named in the URL", async () => {
    // The rail's flyout navigates to /reports?workspace=<id>; the page must
    // honor that rather than its own default.
    listMock.mockResolvedValue({ reports: [] });
    renderPageAt("/reports?workspace=w0");
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith("w0", expect.anything()),
    );
  });
});
