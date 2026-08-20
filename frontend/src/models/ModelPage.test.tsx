import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompositeDefinition, CompositeDetail } from "../api/composites";
import ModelPage from "./ModelPage";

const getMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());
const queryMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../api/composites", () => ({
  getComposite: getMock,
  updateComposite: updateMock,
  queryComposite: queryMock,
}));

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiFetch: fetchMock,
}));

function definition(over: Partial<CompositeDefinition> = {}): CompositeDefinition {
  return {
    schemaVersion: 1,
    name: "Customer 360",
    members: [
      { alias: "sales", database: "A", schema: "P", view: "SALES_SV" },
      { alias: "support", database: "A", schema: "P", view: "SUPPORT_SV" },
    ],
    sharedDimensions: [
      {
        name: "Customer",
        bindings: {
          sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
          support: { table: "CLIENT", column: "CLIENT_ID" },
        },
      },
    ],
    derivedMetrics: [],
    joinType: "full",
    crossFilter: "semi",
    ...over,
  };
}

function detail(over: Partial<CompositeDetail> = {}): CompositeDetail {
  return {
    id: "m1",
    name: "Customer 360",
    workspaceId: "w1",
    workspaceName: "Team",
    myRole: "admin",
    memberCount: 2,
    updatedAt: "2026-08-20T10:00:00Z",
    createdBy: "A_SMITH",
    favorite: false,
    lastViewedAt: null,
    definition: definition(),
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/models/m1"]}>
        <Routes>
          <Route path="/models/:id" element={<ModelPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue(detail());
  updateMock.mockImplementation((_id: string, d: CompositeDefinition) =>
    Promise.resolve(detail({ definition: d })),
  );
  fetchMock.mockResolvedValue({
    views: [
      { database: "A", schema: "P", name: "SALES_SV" },
      { database: "A", schema: "P", name: "SUPPORT_SV" },
      { database: "A", schema: "P", name: "BILLING_SV" },
    ],
  });
  queryMock.mockResolvedValue({
    columns: ["Customer"],
    rows: [["ACME"]],
    truncated: false,
    sfqid: "q1",
    sql: "WITH ...",
    branches: ["sales", "support"],
  });
});

describe("ModelPage", () => {
  it("shows the views the model is over", async () => {
    renderPage();
    expect(await screen.findByText("A.P.SALES_SV")).toBeInTheDocument();
    expect(screen.getByText("A.P.SUPPORT_SV")).toBeInTheDocument();
  });

  it("offers only views that are not already members", async () => {
    renderPage();
    await screen.findByText("A.P.SALES_SV");
    const picker = screen.getByLabelText("Add a view");
    // Adding the same view twice would join a table to itself; the server
    // refuses it, and the picker should not offer it in the first place.
    expect(picker).not.toHaveTextContent("A.P.SALES_SV");
    expect(picker).toHaveTextContent("A.P.BILLING_SV");
  });

  it("removing a view takes its bindings with it", async () => {
    // Leaving a binding behind makes the model unsaveable with an error
    // naming a view that is no longer on screen.
    renderPage();
    await screen.findByText("A.P.SUPPORT_SV");
    await userEvent.click(screen.getByRole("button", { name: /remove SUPPORT_SV/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const saved = updateMock.mock.calls[0][1] as CompositeDefinition;
    expect(saved.members).toHaveLength(1);
    expect(saved.sharedDimensions[0]?.bindings).not.toHaveProperty("support");
  });

  it("says what a filter on one view does to the others", async () => {
    // Power BI made this choice silently and users met it as wrong
    // numbers, so the page has to say which way it is set.
    renderPage();
    expect(
      await screen.findByText(/shows tickets for the customers that filter left/i),
    ).toBeInTheDocument();

    await userEvent.selectOptions(
      screen.getByLabelText("A filter on one view"),
      "local",
    );
    expect(screen.getByText(/leaves ticket counts global/i)).toBeInTheDocument();
  });

  it("cannot add a shared dimension until there are two views", async () => {
    getMock.mockResolvedValue(
      detail({
        definition: definition({
          members: [{ alias: "sales", database: "A", schema: "P", view: "SALES_SV" }],
          sharedDimensions: [],
        }),
      }),
    );
    renderPage();
    await screen.findByText("A.P.SALES_SV");
    expect(screen.getByRole("button", { name: /add a shared dimension/i })).toBeDisabled();
  });

  it("runs the model and says how many views answered", async () => {
    renderPage();
    await screen.findByText("A.P.SALES_SV");
    await userEvent.click(screen.getByRole("checkbox", { name: "Customer" }));
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));

    expect(await screen.findByText(/Answered by 2 views/)).toBeInTheDocument();
  });

  it("shows the SQL on request, because an answer you cannot audit is one you should not act on", async () => {
    renderPage();
    await screen.findByText("A.P.SALES_SV");
    await userEvent.click(screen.getByRole("checkbox", { name: "Customer" }));
    await userEvent.click(screen.getByRole("button", { name: /^run$/i }));
    await screen.findByText(/Answered by 2 views/);

    await userEvent.click(screen.getByRole("button", { name: /show sql/i }));
    expect(screen.getByText("WITH ...")).toBeInTheDocument();
  });

  it("a viewer can read the model but not change it", async () => {
    getMock.mockResolvedValue(detail({ myRole: "viewer" }));
    renderPage();
    await screen.findByText("A.P.SALES_SV");
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    expect(screen.getByLabelText("Model name")).toBeDisabled();
  });
});

describe("derived metrics", () => {
  it("builds a metric from two member metrics and an operator", async () => {
    renderPage();
    await screen.findByText("A.P.SALES_SV");

    await userEvent.type(screen.getByLabelText("Call it"), "Revenue per ticket");
    await userEvent.type(screen.getByLabelText("Take"), "sales:ORDERS.REVENUE");
    await userEvent.type(
      screen.getByLabelText("This"),
      "support:TICKETS.TICKET_COUNT",
    );
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const saved = updateMock.mock.calls[0][1] as CompositeDefinition;
    expect(saved.derivedMetrics).toEqual([
      {
        name: "Revenue per ticket",
        expr: {
          op: "/",
          left: { metric: "sales:ORDERS.REVENUE" },
          right: { metric: "support:TICKETS.TICKET_COUNT" },
        },
        nullIfDenominatorZero: true,
      },
    ]);
  });

  it("reads an existing expression back in words", async () => {
    getMock.mockResolvedValue(
      detail({
        definition: definition({
          derivedMetrics: [
            {
              name: "Revenue per ticket",
              expr: {
                op: "/",
                left: { metric: "sales:ORDERS.REVENUE" },
                right: { metric: "support:TICKETS.TICKET_COUNT" },
              },
            },
          ],
        }),
      }),
    );
    renderPage();
    expect(
      await screen.findByText(
        "sales:ORDERS.REVENUE divided by support:TICKETS.TICKET_COUNT",
      ),
    ).toBeInTheDocument();
  });

  it("cannot combine views until there are two of them", async () => {
    getMock.mockResolvedValue(
      detail({
        definition: definition({
          members: [{ alias: "sales", database: "A", schema: "P", view: "SALES_SV" }],
          sharedDimensions: [],
        }),
      }),
    );
    renderPage();
    await screen.findByText("A.P.SALES_SV");
    expect(screen.getByText(/needs two to combine/i)).toBeInTheDocument();
  });
});
