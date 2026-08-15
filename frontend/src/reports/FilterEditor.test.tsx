import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldInfo, Filter, ViewRef } from "../api/types";
import FilterEditor, { operatorsFor } from "./FilterEditor";

const VIEW: ViewRef = { database: "D", schema: "S", name: "V" };
const REGION: FieldInfo = {
  table: "CUSTOMERS",
  name: "REGION",
  dataType: "VARCHAR(16777216)",
};
const ORDER_DATE: FieldInfo = { table: "ORDERS", name: "ORDER_DATE", dataType: "DATE" };
const AMOUNT: FieldInfo = { table: "ORDERS", name: "AMOUNT", dataType: "NUMBER(38,2)" };

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function stubValues(values: string[], truncated = false) {
  const body = JSON.stringify({ values, truncated });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      // apiFetch reads text() first -- its guard against empty 204 bodies --
      // so a stub with only json() resolves to "response.text is not a
      // function" and the component never sees any data.
      text: async () => body,
      json: async () => JSON.parse(body),
    }),
  );
}

beforeEach(() => stubValues(["EAST", "NORTH", "SOUTH", "WEST"]));
afterEach(() => vi.unstubAllGlobals());

describe("operatorsFor", () => {
  it("offers equality and range on a date", () => {
    expect(operatorsFor("DATE")).toEqual(["is", "isNot", "between", "relativeDate"]);
  });

  it("offers no relative-date option on text", () => {
    expect(operatorsFor("VARCHAR(16777216)")).toEqual(["is", "isNot"]);
  });

  it("offers between on a number but not relativeDate", () => {
    expect(operatorsFor("NUMBER(38,2)")).toEqual(["is", "isNot", "between"]);
  });

  it("falls back to equality when the type is unknown", () => {
    expect(operatorsFor(null)).toEqual(["is", "isNot"]);
  });
});

describe("FilterEditor", () => {
  const noop = () => {};

  it("lists only the operators valid for the field type", () => {
    const filter: Filter = { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: [] };
    wrap(
      <FilterEditor
        field={REGION}
        filter={filter}
        view={VIEW}
        onChange={noop}
        onRemove={noop}
      />,
    );
    const select = screen.getByLabelText(/operator/i) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["is", "isNot"]);
  });

  it("summarises what the filter currently means", () => {
    const filter: Filter = {
      id: "f1",
      field: "CUSTOMERS.REGION",
      op: "is",
      values: ["EAST"],
    };
    wrap(
      <FilterEditor
        field={REGION}
        filter={filter}
        view={VIEW}
        onChange={noop}
        onRemove={noop}
      />,
    );
    expect(screen.getByText("CUSTOMERS.REGION is EAST")).toBeInTheDocument();
  });

  it("offers the field's real values as checkboxes", async () => {
    const filter: Filter = { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: [] };
    wrap(
      <FilterEditor
        field={REGION}
        filter={filter}
        view={VIEW}
        onChange={noop}
        onRemove={noop}
      />,
    );
    expect(await screen.findByRole("checkbox", { name: "EAST" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "WEST" })).toBeInTheDocument();
  });

  it("emits the selected values", async () => {
    const onChange = vi.fn();
    const filter: Filter = { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: [] };
    wrap(
      <FilterEditor
        field={REGION}
        filter={filter}
        view={VIEW}
        onChange={onChange}
        onRemove={noop}
      />,
    );
    await userEvent.click(await screen.findByRole("checkbox", { name: "EAST" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ op: "is", values: ["EAST"] }),
    );
  });

  it("switching operator to between replaces the filter rather than keeping values", async () => {
    const onChange = vi.fn();
    const filter: Filter = { id: "f1", field: "ORDERS.AMOUNT", op: "is", values: ["1"] };
    wrap(
      <FilterEditor
        field={AMOUNT}
        filter={filter}
        view={VIEW}
        onChange={onChange}
        onRemove={noop}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText(/operator/i), "between");
    // A stale `values` key alongside from/to would fail the backend's
    // discriminated union, which forbids extra keys.
    expect(onChange).toHaveBeenCalledWith({
      id: "f1",
      field: "ORDERS.AMOUNT",
      op: "between",
      from: "",
      to: "",
    });
  });

  it("offers a relative-date window on a date field", () => {
    const filter: Filter = {
      id: "f1",
      field: "ORDERS.ORDER_DATE",
      op: "relativeDate",
      unit: "day",
      count: 30,
    };
    wrap(
      <FilterEditor
        field={ORDER_DATE}
        filter={filter}
        view={VIEW}
        onChange={noop}
        onRemove={noop}
      />,
    );
    expect(screen.getByLabelText(/^last$/i)).toHaveValue(30);
    expect(screen.getByLabelText(/unit/i)).toBeInTheDocument();
  });

  it("does not fetch values for an operator that takes none", () => {
    const filter: Filter = {
      id: "f1",
      field: "ORDERS.ORDER_DATE",
      op: "relativeDate",
      preset: "monthToDate",
    };
    wrap(
      <FilterEditor
        field={ORDER_DATE}
        filter={filter}
        view={VIEW}
        onChange={noop}
        onRemove={noop}
      />,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says so when the value list was capped", async () => {
    stubValues(["A"], true);
    const filter: Filter = { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: [] };
    wrap(
      <FilterEditor
        field={REGION}
        filter={filter}
        view={VIEW}
        onChange={noop}
        onRemove={noop}
      />,
    );
    expect(await screen.findByText(/showing the first/i)).toBeInTheDocument();
  });

  it("removes itself", async () => {
    const onRemove = vi.fn();
    const filter: Filter = { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: [] };
    wrap(
      <FilterEditor
        field={REGION}
        filter={filter}
        view={VIEW}
        onChange={noop}
        onRemove={onRemove}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /remove filter/i }));
    expect(onRemove).toHaveBeenCalled();
  });
});
