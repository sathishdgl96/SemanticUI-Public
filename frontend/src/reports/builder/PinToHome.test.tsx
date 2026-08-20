import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PinToHome from "./PinToHome";

const getHomeMock = vi.hoisted(() => vi.fn());
const pinMock = vi.hoisted(() => vi.fn());
const unpinMock = vi.hoisted(() => vi.fn());

vi.mock("../../api/home", () => ({
  getHome: getHomeMock,
  pinVisual: pinMock,
  unpinWidget: unpinMock,
  rearrangeWidgets: vi.fn(),
}));

function widget(overrides: Record<string, unknown> = {}) {
  return {
    id: "w1",
    reportId: "r1",
    pageId: "p1",
    visualId: "v1",
    layout: { x: 0, y: 0, w: 4, h: 4 },
    title: null,
    available: true,
    ...overrides,
  };
}

function renderPin(props: Partial<React.ComponentProps<typeof PinToHome>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PinToHome reportId="r1" pageId="p1" visualId="v1" saved {...props} />
    </QueryClientProvider>,
  );
}

describe("PinToHome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHomeMock.mockResolvedValue({ recent: [], widgets: [] });
    pinMock.mockResolvedValue(widget());
    unpinMock.mockResolvedValue(undefined);
  });

  it("pins the selected visual", async () => {
    renderPin();
    await userEvent.click(await screen.findByRole("button", { name: /pin to home/i }));
    await waitFor(() =>
      expect(pinMock).toHaveBeenCalledWith({
        reportId: "r1",
        pageId: "p1",
        visualId: "v1",
      }),
    );
  });

  it("offers to unpin one that is already there", async () => {
    // Read from the home payload rather than kept in local state, so the
    // button and the home page can never disagree about what is pinned.
    getHomeMock.mockResolvedValue({ recent: [], widgets: [widget()] });
    renderPin();
    const button = await screen.findByRole("button", { name: /unpin from home/i });
    expect(button).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(button);
    await waitFor(() => expect(unpinMock).toHaveBeenCalledWith("w1"));
  });

  it("does not confuse a different visual on the same page for this one", async () => {
    getHomeMock.mockResolvedValue({ recent: [], widgets: [widget({ visualId: "v2" })] });
    renderPin();
    expect(await screen.findByRole("button", { name: /pin to home/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("refuses while the report has unsaved changes, and says why", async () => {
    // A widget resolves against the SAVED document: pinning a visual the
    // server has never seen would store a reference to nothing.
    renderPin({ saved: false });
    const button = await screen.findByRole("button", { name: /pin to home/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringMatching(/save the report/i));
  });

  it("refuses on a report that does not exist yet", async () => {
    renderPin({ reportId: undefined });
    expect(await screen.findByRole("button", { name: /pin to home/i })).toBeDisabled();
  });

  it("reports a failure rather than looking like it worked", async () => {
    pinMock.mockRejectedValue(new Error("boom"));
    renderPin();
    await userEvent.click(await screen.findByRole("button", { name: /pin to home/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not update your home page/i,
    );
  });
});
