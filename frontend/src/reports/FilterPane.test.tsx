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
  visualFilters: null as Filter[] | null,
  selectedVisualTitle: null as string | null,
  onChangeReport: () => {},
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
  it("says the report has no filters yet", () => {
    wrap(<FilterPane {...props} />);
    expect(screen.getByText(/no filters on this page/i)).toBeInTheDocument();
  });

  it("adds a report-scope filter for a chosen field", async () => {
    const onChangeReport = vi.fn();
    wrap(<FilterPane {...props} onChangeReport={onChangeReport} />);
    await userEvent.selectOptions(
      screen.getByLabelText(/add a filter on this page/i),
      "CUSTOMERS.REGION",
    );
    expect(onChangeReport).toHaveBeenCalledWith([
      expect.objectContaining({ field: "CUSTOMERS.REGION", op: "is", values: [] }),
    ]);
  });

  it("labels the two scopes distinctly", () => {
    wrap(
      <FilterPane
        {...props}
        reportFilters={[
          { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: ["EAST"] },
        ]}
        visualFilters={[]}
        selectedVisualTitle="Revenue by region"
      />,
    );
    expect(
      screen.getByRole("heading", { name: /filters on this page/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /filters on "Revenue by region"/i }),
    ).toBeInTheDocument();
  });

  it("hides the visual scope when no visual is selected", () => {
    wrap(<FilterPane {...props} visualFilters={null} />);
    expect(screen.queryByText(/add a filter on this visual/i)).not.toBeInTheDocument();
  });

  it("removes a filter", async () => {
    const onChangeReport = vi.fn();
    wrap(
      <FilterPane
        {...props}
        reportFilters={[
          { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: ["EAST"] },
        ]}
        onChangeReport={onChangeReport}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /remove filter/i }));
    expect(onChangeReport).toHaveBeenCalledWith([]);
  });

  it("does not offer a field that is already filtered at this scope", () => {
    wrap(
      <FilterPane
        {...props}
        reportFilters={[{ id: "f1", field: "CUSTOMERS.REGION", op: "is", values: [] }]}
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
        reportFilters={[
          { id: "f1", field: "ORDERS.ORDER_DATE", op: "is", values: [] },
          { id: "f2", field: "CUSTOMERS.REGION", op: "is", values: [] },
        ]}
        onChangeReport={onChangeReport}
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
