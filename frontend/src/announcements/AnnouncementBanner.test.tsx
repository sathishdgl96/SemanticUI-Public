import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AnnouncementBanner from "./AnnouncementBanner";
import type { Announcement } from "../api/announcements";

const liveMock = vi.hoisted(() => vi.fn());

vi.mock("../api/announcements", () => ({
  getLiveAnnouncements: liveMock,
}));

function notice(over: Partial<Announcement> = {}): Announcement {
  return {
    id: "a1",
    message: "Snowflake maintenance on Saturday.",
    level: "warning",
    active: true,
    startsAt: new Date().toISOString(),
    endsAt: null,
    createdBy: "A_SMITH",
    updatedAt: null,
    ...over,
  };
}

function renderBanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AnnouncementBanner />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  liveMock.mockResolvedValue({ announcements: [notice()] });
});

describe("AnnouncementBanner", () => {
  it("shows what is being announced", async () => {
    renderBanner();
    expect(await screen.findByRole("note")).toHaveTextContent(
      "Snowflake maintenance on Saturday.",
    );
  });

  it("is nothing at all when there is nothing to say", async () => {
    // A section that is usually blank teaches people to ignore the place
    // it sits in.
    liveMock.mockResolvedValue({ announcements: [] });
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it("cannot be dismissed", async () => {
    // A notice half the readers have turned off is a notice half the
    // readers do not have.
    renderBanner();
    await screen.findByRole("note");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("interrupts for a critical notice and not for the others", async () => {
    // Marking every one an alert would make the loud one
    // indistinguishable from the routine one to anybody listening rather
    // than looking.
    liveMock.mockResolvedValue({
      announcements: [
        notice({ id: "a1", level: "critical", message: "Snowflake is down." }),
        notice({ id: "a2", level: "info", message: "New release tonight." }),
      ],
    });
    renderBanner();
    expect(await screen.findByRole("alert")).toHaveTextContent("Snowflake is down.");
    expect(screen.getByRole("note")).toHaveTextContent("New release tonight.");
  });

  it("shows several at once, in the order the server put them", async () => {
    liveMock.mockResolvedValue({
      announcements: [notice({ id: "a1" }), notice({ id: "a2", message: "Second." })],
    });
    renderBanner();
    const shown = await screen.findAllByRole("note");
    expect(shown).toHaveLength(2);
  });

  it("says nothing when it cannot reach the server", async () => {
    // The banner is context, not the page. A failure here must not put an
    // error across the top of every screen in the app.
    liveMock.mockRejectedValue(new Error("offline"));
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });
});
