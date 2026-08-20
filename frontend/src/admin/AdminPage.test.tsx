import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminPage from "./AdminPage";
import type { EventPage, Health, Security } from "../api/admin";

const healthMock = vi.hoisted(() => vi.fn());
const eventsMock = vi.hoisted(() => vi.fn());
const securityMock = vi.hoisted(() => vi.fn());

vi.mock("../api/admin", () => ({
  getHealth: healthMock,
  getEvents: eventsMock,
  getSecurity: securityMock,
  amIAppAdmin: vi.fn().mockResolvedValue({ isAppAdmin: true }),
}));

function health(over: Partial<Health> = {}): Health {
  return {
    status: "ok",
    uptimeSeconds: 3600 * 26,
    checks: [
      {
        name: "Application database",
        status: "ok",
        latencyMs: 1.4,
        detail: "PostgreSQL 16.2",
      },
      { name: "API", status: "ok", latencyMs: null, detail: "pid 42" },
    ],
    counts: { users: 3, workspaces: 2, reports: 7, dashboards: 1, explores: 4 },
    ...over,
  };
}

function events(over: Partial<EventPage> = {}): EventPage {
  return {
    events: [
      {
        id: "e1",
        ts: new Date().toISOString(),
        action: "report.read",
        outcome: "ok",
        user: "ALICE",
        requestId: "abcdef1234",
        sessionRef: "ffff",
        resourceType: "report",
        resourceId: "11112222-3333",
        detail: { rows: 12 },
      },
    ],
    nextBefore: null,
    actions: ["auth.failed", "report.read"],
    ...over,
  };
}

function security(over: Partial<Security> = {}): Security {
  return {
    windowHours: 24,
    alerts: [
      {
        id: "auth-failures",
        severity: "high",
        title: "Failed sign-ins",
        count: 12,
        detail: "12 in the last 24h, from 2 session(s)",
      },
    ],
    recentDenials: [
      {
        id: "d1",
        ts: new Date().toISOString(),
        action: "access.denied",
        outcome: "denied",
        user: "BOB",
        resourceType: "report",
        requestId: "req1",
      },
    ],
    activity: [
      { hour: "2026-08-20T09:00:00+00:00", count: 0 },
      { hour: "2026-08-20T10:00:00+00:00", count: 4 },
    ],
    ...over,
  };
}

function renderAdmin(path = "/admin") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/*" element={<AdminPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  healthMock.mockResolvedValue(health());
  eventsMock.mockResolvedValue(events());
  securityMock.mockResolvedValue(security());
});

describe("Operations", () => {
  it("says whether each moving part is answering, and how fast", async () => {
    renderAdmin();
    expect(await screen.findByText(/all systems answering/i)).toBeInTheDocument();
    expect(screen.getByText("PostgreSQL 16.2")).toBeInTheDocument();
    expect(screen.getByText("1.4 ms")).toBeInTheDocument();
  });

  it("reads uptime in units rather than seconds", async () => {
    renderAdmin();
    expect(await screen.findByText(/1d 2h/)).toBeInTheDocument();
  });

  it("says something is down when something is", async () => {
    healthMock.mockResolvedValue(
      health({
        status: "down",
        checks: [
          {
            name: "Application database",
            status: "down",
            latencyMs: 30.2,
            detail: "OperationalError",
          },
        ],
      }),
    );
    renderAdmin();
    expect(await screen.findByText(/something is down/i)).toBeInTheDocument();
    expect(screen.getByText("DOWN")).toBeInTheDocument();
  });

  it("counts what the install holds", async () => {
    renderAdmin();
    expect(await screen.findByText("Reports")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("reports a failed read rather than an empty page", async () => {
    healthMock.mockRejectedValue(new Error("boom"));
    renderAdmin();
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not read/i);
  });
});

describe("Activity log", () => {
  it("lists what happened, with the actor and the request id", async () => {
    renderAdmin("/admin/activity");
    expect(await screen.findByText("ALICE")).toBeInTheDocument();
    // After the wait: there is no table until the first page lands. The
    // action filter also lists "report.read", so this has to say which.
    const body = document.querySelector("tbody") as HTMLElement;
    expect(within(body).getByText("report.read")).toBeInTheDocument();
    // Short enough to scan; the full id is in the log stream.
    expect(screen.getByTitle(/request id/i)).toHaveTextContent("abcdef12");
  });

  it("offers the actions the trail actually holds", async () => {
    // The list comes back WITH the page, so it is only populated once the
    // first read lands -- which is the point: it is what the trail holds,
    // not a list written months ago.
    renderAdmin("/admin/activity");
    await screen.findByText("ALICE");
    const actions = screen.getByRole("combobox", { name: /action/i });
    expect(
      within(actions).getByRole("option", { name: "auth.failed" }),
    ).toBeInTheDocument();
  });

  it("narrows by action, and starts again at the first page", async () => {
    renderAdmin("/admin/activity");
    await screen.findByText("ALICE");
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /action/i }),
      "auth.failed",
    );
    await waitFor(() =>
      expect(eventsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: "auth.failed", before: undefined }),
      ),
    );
  });

  it("pages by time rather than offset", async () => {
    // The trail grows while it is being read; an offset would skip or
    // repeat rows as it did.
    eventsMock.mockResolvedValue(events({ nextBefore: "2026-08-20T09:00:00+00:00" }));
    renderAdmin("/admin/activity");
    await screen.findByText("ALICE");

    await userEvent.click(screen.getByRole("button", { name: /older/i }));
    await waitFor(() =>
      expect(eventsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ before: "2026-08-20T09:00:00+00:00" }),
      ),
    );
  });

  it("cannot go newer than the first page", async () => {
    renderAdmin("/admin/activity");
    await screen.findByText("ALICE");
    expect(screen.getByRole("button", { name: /newer/i })).toBeDisabled();
  });

  it("says the window is empty rather than showing a bare table", async () => {
    eventsMock.mockResolvedValue(events({ events: [] }));
    renderAdmin("/admin/activity");
    expect(await screen.findByText(/nothing recorded/i)).toBeInTheDocument();
  });
});

describe("Security", () => {
  it("leads with alerts that say what they counted", async () => {
    renderAdmin("/admin/security");
    expect(await screen.findByText("Failed sign-ins")).toBeInTheDocument();
    expect(screen.getByText(/12 in the last 24h/)).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
  });

  it("lists who was refused what", async () => {
    renderAdmin("/admin/security");
    expect(await screen.findByText("access.denied")).toBeInTheDocument();
    expect(screen.getByText("BOB")).toBeInTheDocument();
  });

  it("draws activity as a shape with a readable label", async () => {
    renderAdmin("/admin/security");
    expect(
      await screen.findByRole("img", { name: /4 events over 2 hours/i }),
    ).toBeInTheDocument();
  });

  it("says so when nobody was refused anything", async () => {
    securityMock.mockResolvedValue(security({ recentDenials: [] }));
    renderAdmin("/admin/security");
    expect(await screen.findByText(/nobody was refused/i)).toBeInTheDocument();
  });

  it("asks for a different window on request", async () => {
    renderAdmin("/admin/security");
    await screen.findByText("Failed sign-ins");
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /window/i }),
      String(24 * 7),
    );
    await waitFor(() => expect(securityMock).toHaveBeenLastCalledWith(24 * 7));
  });
});

describe("the admin shell", () => {
  it("moves between its three views without leaving the page", async () => {
    renderAdmin();
    await screen.findByText(/all systems answering/i);
    await userEvent.click(screen.getByRole("link", { name: /activity log/i }));
    expect(await screen.findByText("ALICE")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: /security/i }));
    expect(await screen.findByText("Failed sign-ins")).toBeInTheDocument();
  });

  it("says who it is for", async () => {
    renderAdmin();
    expect(
      await screen.findByText(/administrators named in this deployment/i),
    ).toBeInTheDocument();
  });
});
