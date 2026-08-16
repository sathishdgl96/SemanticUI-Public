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
  it("offers ranges and relative windows on a date", () => {
    const ops = operatorsFor("DATE");
    for (const op of ["is", "isNot", "between", "notBetween", "gt", "lte", "relativeDate"]) {
      expect(ops).toContain(op);
    }
    // Substring matching on a date would compile and mean nothing.
    expect(ops).not.toContain("contains");
  });

  it("offers substring matching on text, but no ranges", () => {
    const ops = operatorsFor("VARCHAR(16777216)");
    for (const op of ["is", "isNot", "contains", "notContains", "startsWith", "endsWith"]) {
      expect(ops).toContain(op);
    }
    // Lexical ordering on free text invites wrong answers.
    expect(ops).not.toContain("gt");
    expect(ops).not.toContain("between");
    expect(ops).not.toContain("relativeDate");
  });

  it("offers ordered comparison on a number, but not relative dates", () => {
    const ops = operatorsFor("NUMBER(38,2)");
    for (const op of ["between", "notBetween", "gt", "gte", "lt", "lte"]) {
      expect(ops).toContain(op);
    }
    expect(ops).not.toContain("relativeDate");
    expect(ops).not.toContain("contains");
  });

  it("offers the presence tests on every type", () => {
    // Any column of any type can be empty.
    for (const type of ["DATE", "NUMBER(38,2)", "VARCHAR(16777216)", null]) {
      expect(operatorsFor(type)).toContain("isBlank");
      expect(operatorsFor(type)).toContain("isNotBlank");
    }
  });

  it("falls back to the text operators when the type is unknown", () => {
    expect(operatorsFor(null)).toContain("contains");
    expect(operatorsFor(null)).not.toContain("gt");
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
    const offered = [...select.options].map((o) => o.value);
    expect(offered).toEqual(operatorsFor(REGION.dataType));
    // A text field gets substring matching and no numeric ordering.
    expect(offered).toContain("contains");
    expect(offered).not.toContain("gt");
  });

  it("shows one value box for a text operator", async () => {
    const onChange = vi.fn();
    const filter: Filter = {
      id: "f1",
      field: "CUSTOMERS.REGION",
      op: "contains",
      value: "",
    };
    wrap(
      <FilterEditor
        field={REGION}
        filter={filter}
        view={VIEW}
        onChange={onChange}
        onRemove={noop}
      />,
    );
    await userEvent.type(screen.getByLabelText(/^value$/i), "AC");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ op: "contains", value: "C" }),
    );
  });

  it("shows no value box for a presence test, and says why", () => {
    const filter: Filter = { id: "f1", field: "CUSTOMERS.REGION", op: "isBlank" };
    wrap(
      <FilterEditor
        field={REGION}
        filter={filter}
        view={VIEW}
        onChange={noop}
        onRemove={noop}
      />,
    );
    expect(screen.queryByLabelText(/^value$/i)).toBeNull();
    expect(screen.getByText(/needs no value/i)).toBeInTheDocument();
  });

  it("rebuilds the filter on an operator change rather than carrying keys over", async () => {
    const onChange = vi.fn();
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
        onChange={onChange}
        onRemove={noop}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText(/operator/i), "contains");
    // `values` must NOT survive: the backend union forbids extra keys.
    expect(onChange).toHaveBeenCalledWith({
      id: "f1",
      field: "CUSTOMERS.REGION",
      op: "contains",
      value: "",
    });
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
