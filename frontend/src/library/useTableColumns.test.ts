import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  compareRows,
  MIN_COLUMN,
  nextSort,
  sortRows,
  useTableColumns,
  type SortableRow,
  type SortState,
} from "./useTableColumns";

function row(over: Partial<SortableRow> = {}): SortableRow {
  return {
    name: "Sales",
    kind: "report",
    detail: "ANALYTICS.PUBLIC.SALES",
    workspaceName: "Team",
    createdBy: "ALICE",
    myRole: "editor",
    updatedAt: "2026-08-19T10:00:00Z",
    lastViewedAt: "2026-08-19T12:00:00Z",
    ...over,
  };
}

describe("nextSort", () => {
  it("takes a new column at the direction that column reads in", () => {
    // Text reads forwards; "sort by Modified" almost always means "what
    // changed lately", so a date starts newest-first.
    const from: SortState = { key: "name", direction: "asc" };
    expect(nextSort(from, "updated")).toEqual({ key: "updated", direction: "desc" });
    expect(nextSort(from, "kind")).toEqual({ key: "kind", direction: "asc" });
  });

  it("reverses the column already sorted by", () => {
    expect(nextSort({ key: "name", direction: "asc" }, "name")).toEqual({
      key: "name",
      direction: "desc",
    });
    expect(nextSort({ key: "name", direction: "desc" }, "name")).toEqual({
      key: "name",
      direction: "asc",
    });
  });
});

describe("compareRows", () => {
  const asc: SortState = { key: "name", direction: "asc" };

  it("orders by the chosen column, both ways", () => {
    const a = row({ name: "Alpha" });
    const b = row({ name: "Beta" });
    expect(compareRows(a, b, asc)).toBeLessThan(0);
    expect(compareRows(a, b, { key: "name", direction: "desc" })).toBeGreaterThan(0);
  });

  it("sorts blanks last whichever way the column points", () => {
    // Never opened, or never bound to a view, is an absence -- not the
    // smallest possible value. Letting "" win an ascending sort puts every
    // gap at the top of the list.
    const missing = row({ name: "Zed", lastViewedAt: null });
    const present = row({ name: "Alpha", lastViewedAt: "2026-01-01T00:00:00Z" });
    for (const direction of ["asc", "desc"] as const) {
      const sort: SortState = { key: "recent", direction };
      expect(compareRows(missing, present, sort)).toBeGreaterThan(0);
      expect(compareRows(present, missing, sort)).toBeLessThan(0);
    }
  });

  it("breaks ties by name, so a list does not reshuffle between renders", () => {
    const a = row({ name: "Alpha", myRole: "admin" });
    const b = row({ name: "Beta", myRole: "admin" });
    const byRole: SortState = { key: "role", direction: "desc" };
    expect(compareRows(a, b, byRole)).toBeLessThan(0);
  });

  it("compares numbers inside names the way a reader would", () => {
    const two = row({ name: "Report 2" });
    const ten = row({ name: "Report 10" });
    expect(compareRows(two, ten, asc)).toBeLessThan(0);
  });
});

describe("sortRows", () => {
  it("returns a new array rather than sorting in place", () => {
    const rows = [row({ name: "B" }), row({ name: "A" })];
    const sorted = sortRows(rows, { key: "name", direction: "asc" });
    expect(sorted.map((r) => r.name)).toEqual(["A", "B"]);
    expect(rows.map((r) => r.name)).toEqual(["B", "A"]);
  });
});

describe("useTableColumns", () => {
  beforeEach(() => window.localStorage.clear());

  it("starts with nothing set, so the stylesheet's defaults apply", () => {
    const { result } = renderHook(() => useTableColumns("k"));
    expect(result.current.widths).toEqual({});
  });

  it("remembers a width across visits", () => {
    const first = renderHook(() => useTableColumns("k"));
    act(() => first.result.current.resize("detail", 320));
    expect(first.result.current.widths.detail).toBe(320);

    const second = renderHook(() => useTableColumns("k"));
    expect(second.result.current.widths.detail).toBe(320);
  });

  it("keeps a column wide enough to read", () => {
    const { result } = renderHook(() => useTableColumns("k"));
    act(() => result.current.resize("detail", 4));
    expect(result.current.widths.detail).toBe(MIN_COLUMN);
  });

  it("forgets one column without forgetting the rest", () => {
    const { result } = renderHook(() => useTableColumns("k"));
    act(() => {
      result.current.resize("detail", 320);
      result.current.resize("role", 120);
    });
    act(() => result.current.reset("detail"));
    expect(result.current.widths).toEqual({ role: 120 });
  });

  it("ignores a stored value that is not a width", () => {
    // localStorage is user-writable and these numbers reach a style
    // attribute.
    window.localStorage.setItem(
      "k",
      JSON.stringify({ detail: "320px", role: -5, kind: null, updated: 140 }),
    );
    const { result } = renderHook(() => useTableColumns("k"));
    expect(result.current.widths).toEqual({ updated: 140 });
  });

  it("survives storage it cannot parse", () => {
    window.localStorage.setItem("k", "{not json");
    const { result } = renderHook(() => useTableColumns("k"));
    expect(result.current.widths).toEqual({});
  });

  it("tracks a drag on the window, not on the grip", () => {
    // The pointer leaves a 6px handle immediately; a drag that stopped
    // when it did would not be a drag.
    const { result } = renderHook(() => useTableColumns("k"));
    act(() =>
      result.current.beginResize(
        {
          clientX: 100,
          preventDefault: () => {},
          stopPropagation: () => {},
        } as unknown as React.PointerEvent,
        "detail",
        200,
      ),
    );
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 160 }));
    });
    expect(result.current.widths.detail).toBe(260);

    act(() => window.dispatchEvent(new PointerEvent("pointerup")));
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 400 }));
    });
    // Released: further movement is somebody else's business.
    expect(result.current.widths.detail).toBe(260);
  });
});
