import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SheetRequest } from "../api/types";
import ConnectPanel from "./ConnectPanel";

const SHEETS: SheetRequest[] = [
  {
    title: "Revenue",
    dimensions: ["C.REGION"],
    metrics: ["A.REV"],
    filters: [],
    orderBy: [],
    context: "",
  },
];

const DETAILS = {
  account: "xriieim-eh01350",
  database: "ANALYTICS",
  schema: "PUBLIC",
  view: "SALES",
  sheets: [
    { title: "Revenue", sql: "SELECT * FROM SEMANTIC_VIEW(\n  \"A\".\"B\".\"C\"\n)" },
    { title: "Orders", sql: "SELECT * FROM SEMANTIC_VIEW(...)" },
  ],
};

function stub(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status < 400,
      status,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => text,
      json: async () => JSON.parse(text),
    }),
  );
}

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const writeText = vi.fn();

beforeEach(() => {
  stub(DETAILS);
  writeText.mockClear();
  vi.stubGlobal("navigator", { clipboard: { writeText } });
});

afterEach(() => vi.unstubAllGlobals());

describe("ConnectPanel", () => {
  it("names the server to enter in Excel", async () => {
    wrap(<ConnectPanel reportId="r1" sheets={SHEETS} onClose={() => {}} />);
    expect(
      await screen.findByText(/xriieim-eh01350\.snowflakecomputing\.com/),
    ).toBeInTheDocument();
  });

  it("gives the Excel steps rather than assuming they are known", async () => {
    wrap(<ConnectPanel reportId="r1" sheets={SHEETS} onClose={() => {}} />);
    expect(await screen.findByText(/From Database → From Snowflake/i)).toBeInTheDocument();
  });

  it("shows one SQL block per visual", async () => {
    wrap(<ConnectPanel reportId="r1" sheets={SHEETS} onClose={() => {}} />);
    expect(await screen.findByText("Revenue")).toBeInTheDocument();
    expect(screen.getByText("Orders")).toBeInTheDocument();
  });

  it("copies a statement to the clipboard", async () => {
    wrap(<ConnectPanel reportId="r1" sheets={SHEETS} onClose={() => {}} />);
    await userEvent.click(
      await screen.findByRole("button", { name: /copy sql for Revenue/i }),
    );
    expect(writeText).toHaveBeenCalledWith(DETAILS.sheets[0].sql);
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("offers a connection file, so the four manual steps are optional", async () => {
    // The question this answers: "can I just download the connected Excel?"
    // One ODC per query, because one ODC holds one query.
    wrap(<ConnectPanel reportId="r1" sheets={SHEETS} onClose={() => {}} />);
    const button = await screen.findByRole("button", {
      name: /download \.odc for Revenue/i,
    });
    await userEvent.click(button);

    const call = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([url]) => String(url).endsWith("/connect.odc"));
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]!.body))).toEqual({ sheet: SHEETS[0] });
  });

  it("leads with the zero-install Power Query URLs", async () => {
    // The only route a locked-down machine can use: no driver, no admin, no
    // add-in. The URL is per visual and copyable.
    wrap(
      <ConnectPanel
        reportId="r1"
        sheets={SHEETS}
        feedVisuals={[{ id: "v9", title: "Revenue by region" }]}
        onClose={() => {}}
      />,
    );
    expect(
      await screen.findByText(/power query — works with nothing installed/i),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /copy feed url for Revenue by region/i }),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("/api/feed/reports/r1/visuals/v9.csv"),
    );
    // And the cell-driven slicing hint is stated where the URL is.
    expect(screen.getByText(/f\.TABLE\.FIELD/)).toBeInTheDocument();
  });

  it("shows no Power Query section when there are no feed visuals", async () => {
    wrap(<ConnectPanel reportId="r1" sheets={SHEETS} onClose={() => {}} />);
    await screen.findByText(/connect live from excel/i);
    expect(screen.queryByText(/power query/i)).toBeNull();
  });

  it("keeps the manual route, and says what the file needs that it does not", async () => {
    // The .odc reaches Snowflake through the ODBC driver. Someone without it
    // should learn that here rather than from an Excel error dialog.
    wrap(<ConnectPanel reportId="r1" sheets={SHEETS} onClose={() => {}} />);
    await userEvent.click(await screen.findByText(/connect by hand instead/i));
    expect(screen.getByText(/ODBC driver/i)).toBeInTheDocument();
    // Both the manual Snowflake route and the Analysis Services route say
    // "Get Data" now, so assert the manual one specifically.
    expect(
      screen.getByText(/From Database → From Snowflake/i),
    ).toBeInTheDocument();
  });

  it("says plainly that no data flows through this app once connected", async () => {
    // The reason this approach was chosen over a token-bearing URL.
    wrap(<ConnectPanel reportId="r1" sheets={SHEETS} onClose={() => {}} />);
    expect(
      await screen.findByText(/no data\s+passes through this application/i),
    ).toBeInTheDocument();
  });

  it("surfaces a failure rather than showing an empty panel", async () => {
    stub({ code: "QUERY_ERROR", message: "Unknown field ORDERS.NOPE" }, 400);
    wrap(<ConnectPanel reportId="r1" sheets={SHEETS} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/ORDERS.NOPE/);
  });

  it("closes", async () => {
    const onClose = vi.fn();
    wrap(<ConnectPanel reportId="r1" sheets={SHEETS} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
