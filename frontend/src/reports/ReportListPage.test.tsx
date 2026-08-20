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
import ReportListPage from "./ReportListPage";

const listMock = vi.mocked(listReports);
const deleteMock = vi.mocked(deleteReport);
const createMock = vi.mocked(createReport);
const favoriteMock = vi.mocked(setFavorite);
const viewMock = vi.mocked(recordView);

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
        <ReportListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ReportListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listMock.mockReset();
  deleteMock.mockReset();
  createMock.mockReset();
  favoriteMock.mockClear();
  viewMock.mockClear();
});

describe("ReportListPage", () => {
  it("lists reports with their bound view", async () => {
    listMock.mockResolvedValue({ reports: [summary()] });
    renderPage();
    expect(await screen.findByText("Sales overview")).toBeInTheDocument();
    expect(screen.getByText(/ANALYTICS\.PUBLIC\.SALES/)).toBeInTheDocument();
  });

  it("invites the user to act when there are no reports", async () => {
    listMock.mockResolvedValue({ reports: [] });
    renderPage();
    expect(await screen.findByText(/no reports yet/i)).toBeInTheDocument();
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

  it("shows an error and keeps the confirm dialog open when delete fails", async () => {
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
    // Failure must not silently dismiss the dialog — the user needs to see
    // why nothing happened and still has Cancel/retry available.
    expect(screen.getByRole("dialog", { name: /confirm delete/i })).toBeInTheDocument();
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
    await screen.findByText(/no reports yet/i);
    await userEvent.click(screen.getByRole("button", { name: /new report/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      /this report must be bound to a semantic view before it can hold visuals/i,
    );
  });
});

describe("ReportListPage browsing", () => {
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
    expect(await screen.findByText(/no reports match/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /clear filters/i }));
    // Cleared, whether that is an empty string or the key dropped -- what
    // matters is that the next fetch carries no search.
    await waitFor(() => expect(listMock.mock.lastCall?.[1]?.q ?? "").toBe(""));
  });

  it("still invites a first report when the workspace is genuinely empty", async () => {
    listMock.mockResolvedValue({ reports: [] });
    renderPage();
    expect(await screen.findByText(/no reports yet/i)).toBeInTheDocument();
  });

  it("records that a report was opened", async () => {
    listMock.mockResolvedValue({ reports: [summary()] });
    renderPage();
    await userEvent.click(await screen.findByRole("link", { name: "Sales overview" }));
    await waitFor(() => expect(viewMock).toHaveBeenCalledWith("report", "r1"));
  });

  it("sorts on request", async () => {
    listMock.mockResolvedValue({ reports: [summary()] });
    renderPage();
    await screen.findByText("Sales overview");
    await userEvent.selectOptions(screen.getByLabelText(/sort/i), "name");
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(
        "w0",
        expect.objectContaining({ sort: "name" }),
      ),
    );
  });
});

describe("ReportListPage workspaces", () => {
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
    await userEvent.click(screen.getByRole("button", { name: /new report/i }));
    expect(createMock).toHaveBeenCalledWith(expect.anything(), "w0");
  });
});

describe("ReportListPage URL scoping", () => {
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
