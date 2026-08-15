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

import { apiFetch, ApiError } from "../api/client";
import ExplorerPage from "./ExplorerPage";

const apiFetchMock = vi.mocked(apiFetch);

const ME = { snowflakeUser: "ALICE", snowflakeAccount: "ACME", mode: "dev" };
const VIEW = { name: "My View", database: "DB", schema: "SCH", comment: null };

function mockRoutes(detailResult: () => Promise<unknown>) {
  apiFetchMock.mockImplementation((...args: unknown[]) => {
    const path = String(args[0]);
    if (path === "/api/me") return Promise.resolve(ME);
    if (path === "/api/semantic-views") return Promise.resolve({ views: [VIEW] });
    if (path.startsWith("/api/semantic-views/")) return detailResult();
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
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  apiFetchMock.mockReset();
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

  it("clears the query client cache and navigates to /login on logout", async () => {
    mockRoutes(() => Promise.reject(new ApiError("VIEW_ERROR", 500, "boom")));
    apiFetchMock.mockImplementation((...args: unknown[]) => {
      const path = String(args[0]);
      if (path === "/api/me") return Promise.resolve(ME);
      if (path === "/api/semantic-views") return Promise.resolve({ views: [VIEW] });
      if (path.startsWith("/api/semantic-views/")) return Promise.reject(new ApiError("VIEW_ERROR", 500, "boom"));
      if (path === "/auth/logout") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
    const { qc } = renderPage();

    // Wait for A's semantic-views list to actually populate the cache, the
    // way a real logged-in session leaves it.
    await screen.findByRole("button", { name: "My View" });
    expect(qc.getQueryData(["semantic-views"])).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: /log out/i }));

    await screen.findByText("Login page");
    expect(qc.getQueryData(["semantic-views"])).toBeUndefined();
  });

  it("clears the cache and navigates to /login even when the logout request itself fails", async () => {
    apiFetchMock.mockImplementation((...args: unknown[]) => {
      const path = String(args[0]);
      if (path === "/api/me") return Promise.resolve(ME);
      if (path === "/api/semantic-views") return Promise.resolve({ views: [VIEW] });
      if (path === "/auth/logout") return Promise.reject(new Error("network down"));
      return Promise.reject(new Error(`unexpected path: ${path}`));
    });
    const { qc } = renderPage();

    await screen.findByRole("button", { name: "My View" });
    expect(qc.getQueryData(["semantic-views"])).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: /log out/i }));

    // Local session is over regardless of whether the server call
    // succeeded — the user must not be stranded on the explorer with a
    // stale cache.
    await screen.findByText("Login page");
    expect(qc.getQueryData(["semantic-views"])).toBeUndefined();
  });
});
