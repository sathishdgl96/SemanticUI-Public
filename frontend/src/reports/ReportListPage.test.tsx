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
import { createReport, deleteReport, listReports } from "../api/reports";
import ReportListPage from "./ReportListPage";

const listMock = vi.mocked(listReports);
const deleteMock = vi.mocked(deleteReport);
const createMock = vi.mocked(createReport);

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
});

describe("ReportListPage", () => {
  it("lists reports with their bound view", async () => {
    listMock.mockResolvedValue({
      reports: [
        {
          id: "r1",
          name: "Sales overview",
          view: { database: "ANALYTICS", schema: "PUBLIC", name: "SALES" },
          updatedAt: "2026-08-15T10:00:00+00:00",
          workspaceId: "w0",
          workspaceName: "My reports",
          myRole: "admin" as const,
        },
      ],
    });
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
      reports: [
        {
          id: "r1",
          name: "Sales overview",
          view: { database: "A", schema: "B", name: "C" },
          updatedAt: "2026-08-15T10:00:00+00:00",
          workspaceId: "w0",
          workspaceName: "My reports",
          myRole: "admin" as const,
        },
      ],
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
      reports: [
        {
          id: "r1",
          name: "Sales overview",
          view: { database: "A", schema: "B", name: "C" },
          updatedAt: "2026-08-15T10:00:00+00:00",
          workspaceId: "w0",
          workspaceName: "My reports",
          myRole: "admin" as const,
        },
      ],
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

describe("ReportListPage workspaces", () => {
  it("scopes the listing to the selected workspace", async () => {
    listMock.mockResolvedValue({ reports: [] });
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    // The personal workspace is selected by default, so the very first fetch
    // is already scoped -- the page never shows an unscoped "everything" list
    // under a switcher that claims one workspace.
    expect(listMock).toHaveBeenCalledWith("w0");
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
      definition: {} as never,
    });
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /new report/i }));
    expect(createMock).toHaveBeenCalledWith(expect.anything(), "w0");
  });
});
