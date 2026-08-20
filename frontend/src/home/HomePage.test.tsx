import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HomePage from "./HomePage";
import type { HomePayload } from "../api/home";

const getHomeMock = vi.hoisted(() => vi.fn());
const unpinMock = vi.hoisted(() => vi.fn());
const rearrangeMock = vi.hoisted(() => vi.fn());

vi.mock("../api/home", () => ({
  getHome: getHomeMock,
  unpinWidget: unpinMock,
  rearrangeWidgets: rearrangeMock,
  pinVisual: vi.fn(),
}));

vi.mock("../api/library", () => ({ recordView: vi.fn().mockResolvedValue({ ok: true }) }));

// The tile runs a real query against the semantic gateway; the home page's
// job is to hand it the right inputs, which is what these tests check.
vi.mock("../reports/VisualTile", () => ({
  default: ({ visual }: { visual: { title: string } }) => (
    <div data-testid="tile">{visual.title}</div>
  ),
}));

function liveWidget(overrides: Record<string, unknown> = {}) {
  return {
    id: "w1",
    reportId: "r1",
    pageId: "p1",
    visualId: "v1",
    layout: { x: 0, y: 0, w: 4, h: 4 },
    title: null,
    available: true as const,
    reportName: "Sales overview",
    workspaceName: "Team",
    myRole: "editor",
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
    widgets: [liveWidget()],
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
    unpinMock.mockResolvedValue(undefined);
    rearrangeMock.mockResolvedValue({ ok: true });
  });

  it("shows what was opened lately, reports and explores together", async () => {
    renderHome();
    await screen.findByTestId("tile");
    // The widget's source link is also called "Sales overview", so the
    // recents assertion has to say which list it means.
    const recents = document.querySelector(".recent-list") as HTMLElement;
    expect(
      within(recents).getByRole("link", { name: /sales overview/i }),
    ).toHaveAttribute("href", "/reports/r1");
    expect(
      within(recents).getByRole("link", { name: /churn by segment/i }),
    ).toHaveAttribute("href", "/explore?explore=e1");
  });

  it("draws each pinned visual, and says which report it came from", async () => {
    renderHome();
    expect(await screen.findByTestId("tile")).toHaveTextContent("Revenue by region");
    // Two things are called "Sales overview" -- a recent item and the
    // widget's source link -- so scope to the widget.
    const footer = document.querySelector(".widget-footer") as HTMLElement;
    expect(within(footer).getByRole("link", { name: "Sales overview" })).toHaveAttribute(
      "href",
      "/reports/r1",
    );
  });

  it("unpins a widget and refetches", async () => {
    renderHome();
    await screen.findByTestId("tile");
    await userEvent.click(screen.getByRole("button", { name: /unpin/i }));
    await waitFor(() => expect(unpinMock).toHaveBeenCalledWith("w1"));
    await waitFor(() => expect(getHomeMock).toHaveBeenCalledTimes(2));
  });

  it("says what a widget with nothing behind it any more is, and offers to remove it", async () => {
    // Not an error state: the frame is still yours, it is the thing inside
    // that went away.
    getHomeMock.mockResolvedValue(
      payload({
        widgets: [
          {
            id: "w2",
            reportId: "r9",
            pageId: "p1",
            visualId: "v1",
            layout: { x: 0, y: 0, w: 4, h: 4 },
            title: null,
            available: false,
            reason: "This report is no longer available.",
          },
        ],
      }),
    );
    renderHome();
    expect(
      await screen.findByText(/this report is no longer available/i),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /remove/i }));
    await waitFor(() => expect(unpinMock).toHaveBeenCalledWith("w2"));
  });

  it("invites a first pin rather than showing an empty grid", async () => {
    getHomeMock.mockResolvedValue(payload({ widgets: [] }));
    renderHome();
    expect(await screen.findByText(/nothing pinned yet/i)).toBeInTheDocument();
  });

  it("says so when nothing has been opened", async () => {
    getHomeMock.mockResolvedValue(payload({ recent: [], widgets: [] }));
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
