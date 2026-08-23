import { DndContext } from "@dnd-kit/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldInfo, Filter, ViewRef } from "../api/types";
import FilterPane from "./FilterPane";

const VIEW: ViewRef = { database: "D", schema: "S", name: "V" };
const FIELDS: FieldInfo[] = [
  { table: "CUSTOMERS", name: "REGION", dataType: "VARCHAR(16777216)" },
  { table: "ORDERS", name: "ORDER_DATE", dataType: "DATE" },
];

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DndContext>{ui}</DndContext>
    </QueryClientProvider>,
  );
}

const props = {
  view: VIEW,
  fields: FIELDS,
  reportFilters: [] as Filter[],
  pageFilters: [] as Filter[],
  visualFilters: null as Filter[] | null,
  selectedVisualTitle: null as string | null,
  onChangeReport: () => {},
  onChangePage: () => {},
  onChangeVisual: () => {},
};

beforeEach(() => {
  const body = JSON.stringify({ values: ["EAST"], truncated: false });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => body,
      json: async () => JSON.parse(body),
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("FilterPane", () => {
  it("says an empty scope is empty, in as few words as that takes", () => {
    wrap(<FilterPane {...props} />);
    // "None", not a sentence. The sentence explaining what a page filter IS
    // now lives behind the scope's info button, where it is read once rather
    // than occupying the pane forever.
    expect(screen.getAllByText("None").length).toBeGreaterThan(0);
  });

  it("explains a scope on request rather than permanently", async () => {
    wrap(<FilterPane {...props} />);
    const about = screen.getByRole("button", { name: /about this page/i });
    expect(screen.queryByRole("note")).toBeNull();

    await userEvent.click(about);
    expect(screen.getByRole("note")).toHaveTextContent(
      /every visual on this page/i,
    );

    await userEvent.click(about);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("adds a page-scope filter for a chosen field", async () => {
    const onChangePage = vi.fn();
    wrap(<FilterPane {...props} onChangePage={onChangePage} />);
    await userEvent.selectOptions(
      screen.getByLabelText(/add a filter on this page/i),
      "CUSTOMERS.REGION",
    );
    expect(onChangePage).toHaveBeenCalledWith([
      expect.objectContaining({ field: "CUSTOMERS.REGION", op: "is", values: [] }),
    ]);
  });

  it("adds an all-pages filter for a chosen field", async () => {
    const onChangeReport = vi.fn();
    wrap(<FilterPane {...props} onChangeReport={onChangeReport} />);
    await userEvent.selectOptions(
      screen.getByLabelText(/add a filter on all pages/i),
      "CUSTOMERS.REGION",
    );
    expect(onChangeReport).toHaveBeenCalledWith([
      expect.objectContaining({ field: "CUSTOMERS.REGION", op: "is", values: [] }),
    ]);
  });

  it("renders the three scopes in PowerBI order: visual, page, all pages", () => {
    wrap(
      <FilterPane
        {...props}
        visualFilters={[]}
        selectedVisualTitle="Revenue by region"
      />,
    );
    expect(
      screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent),
    ).toEqual(["Revenue by region", "This page", "All pages"]);
  });

  it("exposes the page scope as its own drop target", () => {
    wrap(<FilterPane {...props} />);
    expect(screen.getByTestId("filter-drop-page")).toBeInTheDocument();
  });

  it("labels the scopes distinctly", () => {
    wrap(
      <FilterPane
        {...props}
        pageFilters={[
          { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: ["EAST"] },
        ]}
        visualFilters={[]}
        selectedVisualTitle="Revenue by region"
      />,
    );
    expect(screen.getByRole("heading", { name: "This page" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Revenue by region" }),
    ).toBeInTheDocument();
  });

  it("hides the visual scope when no visual is selected", () => {
    wrap(<FilterPane {...props} visualFilters={null} />);
    expect(screen.queryByText(/add a filter on this visual/i)).not.toBeInTheDocument();
  });

  it("removes a filter", async () => {
    const onChangePage = vi.fn();
    wrap(
      <FilterPane
        {...props}
        pageFilters={[
          { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: ["EAST"] },
        ]}
        onChangePage={onChangePage}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /remove filter/i }));
    expect(onChangePage).toHaveBeenCalledWith([]);
  });

  it("does not offer a field that is already filtered at this scope", () => {
    wrap(
      <FilterPane
        {...props}
        pageFilters={[{ id: "f1", field: "CUSTOMERS.REGION", op: "is", values: [] }]}
      />,
    );
    const select = screen.getByLabelText(
      /add a filter on this page/i,
    ) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).not.toContain("CUSTOMERS.REGION");
  });

  it("edits a filter in place", async () => {
    const onChangeReport = vi.fn();
    wrap(
      <FilterPane
        {...props}
        pageFilters={[
          { id: "f1", field: "ORDERS.ORDER_DATE", op: "is", values: [] },
          { id: "f2", field: "CUSTOMERS.REGION", op: "is", values: [] },
        ]}
        onChangePage={onChangeReport}
      />,
    );
    const operators = screen.getAllByLabelText(/operator/i);
    await userEvent.selectOptions(operators[0], "isNot");
    // Only the edited one changes; its neighbour is untouched.
    const next = onChangeReport.mock.calls.at(-1)![0];
    expect(next[0].op).toBe("isNot");
    expect(next[1]).toEqual({
      id: "f2",
      field: "CUSTOMERS.REGION",
      op: "is",
      values: [],
    });
  });

  it("exposes each scope as a drop target", () => {
    wrap(<FilterPane {...props} visualFilters={[]} selectedVisualTitle="T" />);
    expect(screen.getByTestId("filter-drop-report")).toBeInTheDocument();
    expect(screen.getByTestId("filter-drop-visual")).toBeInTheDocument();
  });
});
