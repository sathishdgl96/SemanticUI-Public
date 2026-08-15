import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api/reports", () => ({ importReport: vi.fn() }));
vi.mock("../api/client", () => ({
  ApiError: class extends Error {
    code: string; status: number; detail?: string | null;
    constructor(code: string, status: number, message: string) {
      super(message); this.code = code; this.status = status;
    }
  },
  apiFetch: vi.fn(),
  setOnAuthExpired: vi.fn(),
}));

import { ApiError } from "../api/client";
import { importReport } from "../api/reports";
import type { ReportDetail } from "../api/types";
import ImportPanel from "./ImportPanel";

const importMock = vi.mocked(importReport);

// ImportPanel now runs its submit through `useMutation` (see Finding 5 of
// the Task 13/14 fix report), which requires a `QueryClientProvider`
// ancestor — the same wrapping BuilderPage.test.tsx already uses.
function renderPanel(
  onImported: (report: ReportDetail) => void = () => {},
  onClose: () => void = () => {},
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ImportPanel onImported={onImported} onClose={onClose} />
    </QueryClientProvider>,
  );
}

describe("ImportPanel", () => {
  it("rejects text that is not JSON before calling the server", async () => {
    renderPanel();
    await userEvent.type(screen.getByLabelText(/paste a report definition/i), "not json");
    await userEvent.click(screen.getByRole("button", { name: /^import$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/valid json/i);
    expect(importMock).not.toHaveBeenCalled();
  });

  it("passes a view override when one is supplied", async () => {
    importMock.mockResolvedValue({
      id: "r2", name: "Imported", view: { database: "P", schema: "M", name: "V" },
      updatedAt: "", definition: {} as never,
    });
    const onImported = vi.fn();
    renderPanel(onImported);
    await userEvent.type(
      // `userEvent.type` parses `{` as the start of a special key
      // descriptor (see the library's `readNextDescriptor`); doubling it
      // is the documented escape for a literal brace. `}` is not a trigger
      // character on its own, so it needs no escaping. This changes only
      // how the literal JSON text is *expressed* for the typing simulator —
      // the textarea still ends up holding `{"schemaVersion":1}` verbatim.
      screen.getByLabelText(/paste a report definition/i), '{{"schemaVersion":1}',
    );
    await userEvent.type(screen.getByLabelText(/database/i), "P");
    await userEvent.type(screen.getByLabelText(/schema/i), "M");
    await userEvent.type(screen.getByLabelText(/^view$/i), "V");
    await userEvent.click(screen.getByRole("button", { name: /^import$/i }));
    await waitFor(() =>
      expect(importMock).toHaveBeenCalledWith(
        { schemaVersion: 1 }, { database: "P", schema: "M", name: "V" },
      ),
    );
    expect(onImported).toHaveBeenCalled();
  });

  it("shows the backend's reason verbatim, since it names the bad fields", async () => {
    importMock.mockRejectedValue(
      new ApiError(
        "REPORT_INVALID", 400,
        "This report references fields that do not exist in the target view, or that your Snowflake role cannot see: A.SECRET",
      ),
    );
    renderPanel();
    await userEvent.type(
      screen.getByLabelText(/paste a report definition/i), '{{"schemaVersion":1}',
    );
    await userEvent.click(screen.getByRole("button", { name: /^import$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/A\.SECRET/);
  });

  it("survives closing mid-import without throwing or logging (no setState-after-unmount)", async () => {
    let resolveImport: (report: ReportDetail) => void = () => {};
    importMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve;
        }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderPanel();
    await userEvent.type(
      screen.getByLabelText(/paste a report definition/i), '{{"schemaVersion":1}',
    );
    await userEvent.click(screen.getByRole("button", { name: /^import$/i }));
    expect(await screen.findByRole("button", { name: /^importing…$/i })).toBeInTheDocument();

    // Close (unmount) while the request is still in flight, then let the
    // request settle. With plain component state this called `setState` on
    // an unmounted component; with `useMutation` the resolution only
    // updates react-query's own store, which no longer has a subscriber.
    unmount();
    expect(() =>
      resolveImport({
        id: "r2", name: "Imported", view: { database: "P", schema: "M", name: "V" },
        updatedAt: "", definition: {} as never,
      }),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
