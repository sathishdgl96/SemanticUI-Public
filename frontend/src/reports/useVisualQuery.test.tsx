import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hierarchy, ViewRef, Visual } from "../api/types";
import { useVisualQuery } from "./useVisualQuery";

const VIEW: ViewRef = { database: "D", schema: "S", name: "V" };

const GEO: Hierarchy = {
  id: "h1",
  name: "Geography",
  levels: ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE"],
};

function visual(overrides: Partial<Visual> = {}): Visual {
  return {
    id: "v1",
    type: "bar",
    title: "",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells: { axis: ["CUSTOMERS.REGION"], legend: [], values: ["ORDERS.TOTAL"] },
    options: {},
    filters: [],
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function lastBody() {
  const call = fetchMock.mock.calls.at(-1);
  return JSON.parse(call![1].body);
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ columns: [], rows: [], truncated: false, sfqid: "q", sql: "" }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useVisualQuery", () => {
  it("sends an empty filter list when there are none", async () => {
    renderHook(() => useVisualQuery(VIEW, visual()), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastBody().filters).toEqual([]);
  });

  it("sends the composed filter set", async () => {
    renderHook(
      () =>
        useVisualQuery(VIEW, visual(), {
          reportFilters: [
            { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: ["EAST"] },
          ],
        }),
      { wrapper },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastBody().filters).toEqual([
      { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: ["EAST"] },
    ]);
  });

  it("refetches when a filter changes rather than serving the cached result", async () => {
    const { rerender } = renderHook(
      ({ region }: { region: string }) =>
        useVisualQuery(VIEW, visual(), {
          reportFilters: [
            { id: "f1", field: "CUSTOMERS.REGION", op: "is", values: [region] },
          ],
        }),
      { wrapper, initialProps: { region: "EAST" } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ region: "WEST" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lastBody().filters[0].values).toEqual(["WEST"]);
  });

  it("does not refetch when nothing that affects the result changed", async () => {
    const { rerender } = renderHook(
      ({ title }: { title: string }) => useVisualQuery(VIEW, visual({ title })),
      { wrapper, initialProps: { title: "A" } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ title: "B" });
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("selects the drilled level, and refetches when the drill advances", async () => {
    const { rerender } = renderHook(
      ({ depth }: { depth: number }) =>
        useVisualQuery(
          VIEW,
          visual({
            wells: { axis: ["hierarchy:h1"], legend: [], values: ["ORDERS.TOTAL"] },
          }),
          {
            hierarchies: [GEO],
            drill: {
              hierarchyId: "h1",
              path: depth ? [{ field: "CUSTOMERS.COUNTRY", value: "US" }] : [],
            },
          },
        ),
      { wrapper, initialProps: { depth: 0 } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastBody().dimensions).toEqual(["CUSTOMERS.COUNTRY"]);

    rerender({ depth: 1 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lastBody().dimensions).toEqual(["CUSTOMERS.STATE"]);
    expect(lastBody().filters).toEqual([
      {
        id: "drill:CUSTOMERS.COUNTRY",
        field: "CUSTOMERS.COUNTRY",
        op: "is",
        values: ["US"],
      },
    ]);
  });

  it("never sends a hierarchy reference to the query API", async () => {
    renderHook(
      () =>
        useVisualQuery(
          VIEW,
          visual({
            wells: { axis: ["hierarchy:h1"], legend: [], values: ["ORDERS.TOTAL"] },
          }),
          { hierarchies: [GEO] },
        ),
      { wrapper },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.stringify(lastBody())).not.toContain("hierarchy:");
  });

  it("refetches when a cross-filter selection appears", async () => {
    const { rerender } = renderHook(
      ({ on }: { on: boolean }) =>
        useVisualQuery(VIEW, visual(), {
          crossFilter: on
            ? { sourceVisualId: "v2", field: "CUSTOMERS.REGION", value: "EAST" }
            : null,
        }),
      { wrapper, initialProps: { on: false } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ on: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lastBody().filters[0].values).toEqual(["EAST"]);
  });

  it("stays disabled while the wells are invalid", () => {
    const { result } = renderHook(
      () => useVisualQuery(VIEW, visual({ wells: { axis: [], legend: [], values: [] } })),
      { wrapper },
    );
    expect(result.current.ready).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is not ready when the hierarchy on its axis no longer exists", () => {
    const { result } = renderHook(
      () =>
        useVisualQuery(
          VIEW,
          visual({
            wells: { axis: ["hierarchy:gone"], legend: [], values: ["ORDERS.TOTAL"] },
          }),
          { hierarchies: [] },
        ),
      { wrapper },
    );
    expect(result.current.ready).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
