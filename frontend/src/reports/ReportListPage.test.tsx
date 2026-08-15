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

import { deleteReport, listReports } from "../api/reports";
import ReportListPage from "./ReportListPage";

const listMock = vi.mocked(listReports);
const deleteMock = vi.mocked(deleteReport);

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
});
