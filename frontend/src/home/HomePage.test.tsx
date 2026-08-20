import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HomePage from "./HomePage";
import type { HomePayload } from "../api/home";

const getHomeMock = vi.hoisted(() => vi.fn());
const listDashboardsMock = vi.hoisted(() => vi.fn());
const setHomeDashboardMock = vi.hoisted(() => vi.fn());
const removeTileMock = vi.hoisted(() => vi.fn());
const updateDashboardMock = vi.hoisted(() => vi.fn());

vi.mock("../api/home", () => ({ getHome: getHomeMock }));
vi.mock("../api/dashboards", () => ({
  listDashboards: listDashboardsMock,
  setHomeDashboard: setHomeDashboardMock,
  removeTile: removeTileMock,
  updateDashboard: updateDashboardMock,
  addTile: vi.fn(),
  createDashboard: vi.fn(),
  deleteDashboard: vi.fn(),
  getDashboard: vi.fn(),
}));
vi.mock("../api/library", () => ({ recordView: vi.fn().mockResolvedValue({ ok: true }) }));

// The tile runs a real query against the semantic gateway; the home page's
// job is to hand it the right inputs, which is what these tests check.
vi.mock("../reports/VisualTile", () => ({
  default: ({ visual }: { visual: { title: string } }) => (
    <div data-testid="tile">{visual.title}</div>
  ),
}));

function tile(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    reportId: "r1",
    pageId: "p1",
    visualId: "v1",
    layout: { x: 0, y: 0, w: 4, h: 4 },
    title: null,
    available: true,
    reportName: "Sales overview",
    view: { database: "ANALYTICS", schema: "PUBLIC", name: "SALES" },
    visual: {
      id: "v1",
      type: "bar",
      title: "Revenue by region",
      layout: { x: 0, y: 0, w: 6, h: 6 },
      wells: {},
      options: {},
      filters: [],
    },
    reportFilters: [],
    pageFilters: [],
    hierarchies: [],
    ...overrides,
  };
}

function dashboard(overrides: Record<string, unknown> = {}) {
  return {
    id: "d1",
    name: "Ops",
    workspaceId: "w0",
    workspaceName: "Team",
    myRole: "editor",
    tileCount: 1,
    updatedAt: new Date().toISOString(),
    tiles: [tile()],
    ...overrides,
  };
}

function payload(overrides: Partial<HomePayload> = {}): HomePayload {
  return {
    recent: [
      {
        itemType: "report",
        id: "r1",
        name: "Sales overview",
        workspaceName: "Team",
        lastViewedAt: new Date().toISOString(),
      },
      {
        itemType: "explore",
        id: "e1",
        name: "Churn by segment",
        workspaceName: "My reports",
        lastViewedAt: new Date().toISOString(),
      },
    ],
    dashboard: dashboard(),
    ...overrides,
  } as HomePayload;
}

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("HomePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHomeMock.mockResolvedValue(payload());
    listDashboardsMock.mockResolvedValue({ dashboards: [] });
    setHomeDashboardMock.mockResolvedValue({ dashboardId: null });
    removeTileMock.mockResolvedValue(undefined);
    updateDashboardMock.mockResolvedValue(dashboard());
  });

  it("shows what was opened lately, reports and explores together", async () => {
    renderHome();
    await screen.findByTestId("tile");
    // The tile's own menu also names the report, so the recents assertion
    // has to say which list it means.
    const recents = document.querySelector(".recent-list") as HTMLElement;
    expect(
      within(recents).getByRole("link", { name: /sales overview/i }),
    ).toHaveAttribute("href", "/reports/r1");
    expect(
      within(recents).getByRole("link", { name: /churn by segment/i }),
    ).toHaveAttribute("href", "/explore?explore=e1");
  });

  it("draws the chosen dashboard, and links to it", async () => {
    renderHome();
    expect(await screen.findByTestId("tile")).toHaveTextContent("Revenue by region");
    expect(screen.getByRole("link", { name: "Ops" })).toHaveAttribute(
      "href",
      "/dashboards/d1",
    );
  });

  it("offers a dashboard to choose when none is set", async () => {
    // The same state as never having chosen, the chosen one being deleted,
    // and losing access to its workspace -- all three mean "pick one".
    getHomeMock.mockResolvedValue(payload({ dashboard: null }));
    listDashboardsMock.mockResolvedValue({
      dashboards: [
        {
          id: "d2",
          name: "Finance",
          workspaceId: "w0",
          workspaceName: "Team",
          myRole: "viewer",
          tileCount: 3,
          updatedAt: null,
        },
      ],
    });
    renderHome();
    await userEvent.click(await screen.findByRole("button", { name: /finance/i }));
    await waitFor(() => expect(setHomeDashboardMock).toHaveBeenCalledWith("d2"));
  });

  it("points at creating one when there are no dashboards at all", async () => {
    getHomeMock.mockResolvedValue(payload({ dashboard: null }));
    renderHome();
    expect(await screen.findByText(/no dashboards yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create one/i })).toHaveAttribute(
      "href",
      "/reports?kind=dashboard",
    );
  });

  it("clears the choice so another can be picked", async () => {
    renderHome();
    await screen.findByTestId("tile");
    await userEvent.click(screen.getByRole("button", { name: /change/i }));
    await waitFor(() => expect(setHomeDashboardMock).toHaveBeenCalledWith(null));
  });

  it("removes a tile from the right-click menu", async () => {
    renderHome();
    const cell = (await screen.findByTestId("tile")).closest(".tile-cell") as HTMLElement;
    await userEvent.pointer({ keys: "[MouseRight]", target: cell });
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /remove from dashboard/i }),
    );
    await waitFor(() => expect(removeTileMock).toHaveBeenCalledWith("d1", "t1"));
  });

  it("does not offer to remove a tile to someone who may only read it", async () => {
    getHomeMock.mockResolvedValue(
      payload({ dashboard: dashboard({ myRole: "viewer" }) as never }),
    );
    renderHome();
    const cell = (await screen.findByTestId("tile")).closest(".tile-cell") as HTMLElement;
    await userEvent.pointer({ keys: "[MouseRight]", target: cell });
    expect(
      await screen.findByRole("menuitem", { name: /remove from dashboard/i }),
    ).toBeDisabled();
  });

  it("says so when nothing has been opened", async () => {
    getHomeMock.mockResolvedValue(payload({ recent: [] }));
    renderHome();
    expect(await screen.findByText(/nothing opened yet/i)).toBeInTheDocument();
  });

  it("reports a failed load rather than showing an empty page", async () => {
    getHomeMock.mockRejectedValue(new Error("boom"));
    renderHome();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not load your home page/i,
    );
  });
});
