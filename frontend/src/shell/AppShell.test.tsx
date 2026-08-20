import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  setOnAuthExpired: vi.fn(),
  ApiError: class extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number, message: string) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));

import { apiFetch } from "../api/client";
import AppShell from "./AppShell";

const apiFetchMock = vi.mocked(apiFetch);

const ME = { snowflakeUser: "ALICE", snowflakeAccount: "ACME", mode: "dev" };
const WORKSPACES = {
  workspaces: [
    {
      id: "w0",
      name: "My reports",
      kind: "personal",
      myRole: "admin",
      memberCount: 1,
      reportCount: 2,
    },
    {
      id: "w1",
      name: "Team",
      kind: "shared",
      myRole: "editor",
      memberCount: 3,
      reportCount: 5,
    },
  ],
};

function stubApi(overrides: Record<string, unknown> = {}) {
  apiFetchMock.mockImplementation((...args: unknown[]) => {
    const path = String(args[0]);
    if (path in overrides) {
      const value = overrides[path];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }
    if (path === "/api/me") return Promise.resolve(ME);
    if (path === "/api/workspaces") return Promise.resolve(WORKSPACES);
    // Answered for everyone: the endpoint is not behind the admin gate,
    // so drawing the rail costs no audited denial.
    if (path === "/api/admin/whoami") return Promise.resolve({ isAppAdmin: false });
    if (path === "/auth/logout") return Promise.resolve(undefined);
    return Promise.reject(new Error(`unexpected path: ${path}`));
  });
}

function renderShellAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<p>Login page</p>} />
          <Route
            path="/reports"
            element={
              <AppShell>
                <p>Reports content</p>
              </AppShell>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

function renderShell() {
  return renderShellAt("/reports");
}

beforeEach(() => {
  apiFetchMock.mockReset();
  stubApi();
});

describe("AppShell", () => {
  it("frames the page with the brand, nav rail and content", async () => {
    renderShell();
    expect(screen.getByText("SemanticUI")).toBeInTheDocument();
    // Home and Browse are separate destinations: home is your recents and
    // the dashboard you chose, Browse is everything in a workspace. There
    // is deliberately no menu per KIND -- reports, dashboards and explores
    // are one list with a filter.
    expect(screen.getByRole("link", { name: /home/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /^browse$/i })).toHaveAttribute(
      "href",
      "/reports",
    );
    expect(screen.queryByRole("link", { name: /^dashboards$/i })).toBeNull();
    expect(screen.getByRole("link", { name: /explore/i })).toHaveAttribute(
      "href",
      "/explore",
    );
    expect(screen.getByText("Reports content")).toBeInTheDocument();
    expect(await screen.findByText("ALICE @ ACME")).toBeInTheDocument();
  });

  it("hides the admin entry from everyone who is not one", async () => {
    // Absent rather than disabled: a control that is visible and refuses
    // is an invitation to try.
    renderShell();
    await screen.findByText("Reports content");
    expect(screen.queryByRole("link", { name: /admin/i })).toBeNull();
  });

  it("shows the admin entry to an administrator", async () => {
    stubApi({ "/api/admin/whoami": { isAppAdmin: true } });
    renderShell();
    expect(await screen.findByRole("link", { name: /admin/i })).toHaveAttribute(
      "href",
      "/admin",
    );
  });

  it("does not mark Browse current while you are inside a workspace", async () => {
    // Browse and "a workspace" are the same route with and without a
    // ?workspace=. Lighting Browse up inside one said you were somewhere
    // you were not.
    renderShellAt("/reports?workspace=w1");
    expect(screen.getByRole("link", { name: /^browse$/i })).not.toHaveClass("active");
    expect(screen.getByRole("button", { name: /workspaces/i })).toHaveClass("active");
  });

  it("marks Browse current when no workspace is named", async () => {
    renderShellAt("/reports");
    expect(screen.getByRole("link", { name: /^browse$/i })).toHaveClass("active");
  });

  it("closes the workspaces flyout on the way to another page", async () => {
    // The flyout is a way of GETTING somewhere, so arriving anywhere ends
    // it. It used to stay open over the page it had just navigated to, and
    // over every page reached from the rail afterwards.
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: /workspaces/i }));
    expect(screen.getByRole("dialog", { name: /workspaces/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: /explore/i }));
    expect(screen.queryByRole("dialog", { name: /workspaces/i })).toBeNull();
  });

  it("opens the workspaces flyout and navigates to the chosen workspace", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: /workspaces/i }));
    const flyout = await screen.findByRole("dialog", { name: /workspaces/i });
    expect(flyout).toHaveTextContent("My reports");
    expect(flyout).toHaveTextContent("Team");
    expect(flyout).toHaveTextContent("editor · 5 reports");

    await userEvent.click(screen.getByRole("button", { name: /Team/ }));
    // Navigation to /reports?workspace=w1 keeps this same route mounted; the
    // flyout closing is the observable effect here.
    expect(screen.queryByRole("dialog", { name: /workspaces/i })).toBeNull();
  });

  it("closes the flyout on Escape", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("button", { name: /workspaces/i }));
    await screen.findByRole("dialog", { name: /workspaces/i });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /workspaces/i })).toBeNull();
  });

  it("clears the query client cache and navigates to /login on logout", async () => {
    // Moved from ExplorerPage.test.tsx with the control itself. The property
    // is the 2a security fix: user A's cached data must not survive to be
    // rendered to whoever logs in next.
    const { qc } = renderShell();
    await screen.findByText("ALICE @ ACME");
    expect(qc.getQueryData(["me"])).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: /log out/i }));

    await screen.findByText("Login page");
    expect(qc.getQueryData(["me"])).toBeUndefined();
  });

  it("clears the cache and navigates even when the logout request fails", async () => {
    stubApi({ "/auth/logout": new Error("network down") });
    const { qc } = renderShell();
    await screen.findByText("ALICE @ ACME");
    expect(qc.getQueryData(["me"])).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: /log out/i }));

    // Local session is over regardless -- the user must not be stranded with
    // a stale cache.
    await screen.findByText("Login page");
    expect(qc.getQueryData(["me"])).toBeUndefined();
  });
});
