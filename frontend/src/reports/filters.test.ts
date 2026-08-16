import { describe, expect, it } from "vitest";
import type { Filter, Hierarchy, Page, Visual } from "../api/types";
import {
  canDrillDown,
  currentLevel,
  describeFilter,
  drillFilters,
  effectiveFilters,
  hierarchyIdOf,
  isActive,
  resolveWells,
  sheetRequestsFor,
} from "./filters";

const GEO: Hierarchy = {
  id: "h1",
  name: "Geography",
  levels: ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY"],
};

const REGION_IS_EAST: Filter = {
  id: "f1",
  field: "CUSTOMERS.REGION",
  op: "is",
  values: ["EAST"],
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

describe("hierarchyIdOf", () => {
  it("reads the id out of a hierarchy reference", () => {
    expect(hierarchyIdOf("hierarchy:h1")).toBe("h1");
  });

  it("returns null for a plain field reference", () => {
    expect(hierarchyIdOf("CUSTOMERS.REGION")).toBeNull();
  });
});

describe("resolveWells", () => {
  it("leaves plain references alone", () => {
    const wells = { axis: ["CUSTOMERS.REGION"], values: ["ORDERS.TOTAL"] };
    expect(resolveWells(wells, [GEO], undefined)).toEqual(wells);
  });

  it("resolves a hierarchy reference to its top level when undrilled", () => {
    const out = resolveWells(
      { axis: ["hierarchy:h1"], values: ["ORDERS.TOTAL"] },
      [GEO],
      undefined,
    );
    expect(out.axis).toEqual(["CUSTOMERS.COUNTRY"]);
  });

  it("resolves to the level matching the drill depth", () => {
    const out = resolveWells({ axis: ["hierarchy:h1"], values: [] }, [GEO], {
      hierarchyId: "h1",
      path: [{ field: "CUSTOMERS.COUNTRY", value: "US" }],
    });
    expect(out.axis).toEqual(["CUSTOMERS.STATE"]);
  });

  it("clamps to the last level rather than running off the end", () => {
    const out = resolveWells({ axis: ["hierarchy:h1"], values: [] }, [GEO], {
      hierarchyId: "h1",
      path: [
        { field: "CUSTOMERS.COUNTRY", value: "US" },
        { field: "CUSTOMERS.STATE", value: "CA" },
        { field: "CUSTOMERS.CITY", value: "SF" },
      ],
    });
    expect(out.axis).toEqual(["CUSTOMERS.CITY"]);
  });

  it("drops a reference to a hierarchy the report no longer declares", () => {
    const out = resolveWells({ axis: ["hierarchy:gone"], values: [] }, [GEO], undefined);
    expect(out.axis).toEqual([]);
  });

  it("ignores a drill state belonging to a different hierarchy", () => {
    const out = resolveWells({ axis: ["hierarchy:h1"], values: [] }, [GEO], {
      hierarchyId: "other",
      path: [{ field: "X.Y", value: "1" }],
    });
    expect(out.axis).toEqual(["CUSTOMERS.COUNTRY"]);
  });
});

describe("currentLevel / canDrillDown", () => {
  it("reports the level for a depth", () => {
    expect(currentLevel(GEO, 0)).toBe("CUSTOMERS.COUNTRY");
    expect(currentLevel(GEO, 2)).toBe("CUSTOMERS.CITY");
  });

  it("allows drilling until the last level", () => {
    expect(canDrillDown(GEO, 0)).toBe(true);
    expect(canDrillDown(GEO, 1)).toBe(true);
    expect(canDrillDown(GEO, 2)).toBe(false);
  });
});

describe("drillFilters", () => {
  it("produces nothing at the top level", () => {
    expect(drillFilters(undefined)).toEqual([]);
    expect(drillFilters({ hierarchyId: "h1", path: [] })).toEqual([]);
  });

  it("produces one equality filter per level already traversed", () => {
    const out = drillFilters({
      hierarchyId: "h1",
      path: [
        { field: "CUSTOMERS.COUNTRY", value: "US" },
        { field: "CUSTOMERS.STATE", value: "CA" },
      ],
    });
    expect(out).toEqual([
      {
        id: "drill:CUSTOMERS.COUNTRY",
        field: "CUSTOMERS.COUNTRY",
        op: "is",
        values: ["US"],
      },
      { id: "drill:CUSTOMERS.STATE", field: "CUSTOMERS.STATE", op: "is", values: ["CA"] },
    ]);
  });

  it("derives ids from the field so the query key stays stable", () => {
    const a = drillFilters({ hierarchyId: "h1", path: [{ field: "F", value: "1" }] });
    const b = drillFilters({ hierarchyId: "h1", path: [{ field: "F", value: "1" }] });
    expect(a).toEqual(b);
  });
});

describe("effectiveFilters", () => {
  it("intersects report scope and visual scope, report first", () => {
    const own: Filter = { id: "f2", field: "ORDERS.CHANNEL", op: "is", values: ["WEB"] };
    const out = effectiveFilters({
      reportFilters: [REGION_IS_EAST],
      visual: visual({ filters: [own] }),
    });
    expect(out).toEqual([REGION_IS_EAST, own]);
  });

  it("appends the drill path", () => {
    const out = effectiveFilters({
      reportFilters: [],
      visual: visual(),
      drill: { hierarchyId: "h1", path: [{ field: "CUSTOMERS.COUNTRY", value: "US" }] },
    });
    expect(out).toHaveLength(1);
    expect(out[0].field).toBe("CUSTOMERS.COUNTRY");
  });

  it("applies a cross-filter from another visual", () => {
    const out = effectiveFilters({
      reportFilters: [],
      visual: visual(),
      crossFilter: { sourceVisualId: "v2", field: "CUSTOMERS.REGION", value: "EAST" },
    });
    expect(out).toEqual([
      { id: "xf:CUSTOMERS.REGION", field: "CUSTOMERS.REGION", op: "is", values: ["EAST"] },
    ]);
  });

  it("never cross-filters the visual the selection came from", () => {
    const out = effectiveFilters({
      reportFilters: [],
      visual: visual({ id: "v2" }),
      crossFilter: { sourceVisualId: "v2", field: "CUSTOMERS.REGION", value: "EAST" },
    });
    expect(out).toEqual([]);
  });

  it("keeps every scope when all four are present", () => {
    const own: Filter = { id: "f2", field: "ORDERS.CHANNEL", op: "is", values: ["WEB"] };
    const out = effectiveFilters({
      reportFilters: [REGION_IS_EAST],
      visual: visual({ filters: [own] }),
      drill: { hierarchyId: "h1", path: [{ field: "CUSTOMERS.COUNTRY", value: "US" }] },
      crossFilter: { sourceVisualId: "v9", field: "ORDERS.SEGMENT", value: "SMB" },
    });
    expect(out.map((f) => f.field)).toEqual([
      "CUSTOMERS.REGION",
      "ORDERS.CHANNEL",
      "CUSTOMERS.COUNTRY",
      "ORDERS.SEGMENT",
    ]);
  });

  it("tolerates a visual with no filters array (a v1 document in flight)", () => {
    const legacy = { ...visual(), filters: undefined } as unknown as Visual;
    expect(effectiveFilters({ reportFilters: [], visual: legacy })).toEqual([]);
  });
});

describe("describeFilter", () => {
  it("summarises an is filter", () => {
    expect(describeFilter(REGION_IS_EAST)).toBe("CUSTOMERS.REGION is EAST");
  });

  it("counts a multi-value is filter rather than listing everything", () => {
    expect(describeFilter({ id: "f", field: "F", op: "is", values: ["A", "B", "C"] })).toBe(
      "F is 3 values",
    );
  });

  it("summarises isNot, between and relativeDate", () => {
    expect(describeFilter({ id: "f", field: "F", op: "isNot", values: ["A"] })).toBe(
      "F is not A",
    );
    expect(describeFilter({ id: "f", field: "F", op: "between", from: 1, to: 9 })).toBe(
      "F is between 1 and 9",
    );
    expect(
      describeFilter({ id: "f", field: "F", op: "relativeDate", unit: "day", count: 30 }),
    ).toBe("F in the last 30 days");
    expect(
      describeFilter({ id: "f", field: "F", op: "relativeDate", preset: "monthToDate" }),
    ).toBe("F month to date");
  });
});

describe("isActive", () => {
  it("treats an empty selection as not filtering yet", () => {
    expect(isActive({ id: "f", field: "F", op: "is", values: [] })).toBe(false);
    expect(isActive({ id: "f", field: "F", op: "isNot", values: [] })).toBe(false);
  });

  it("treats a chosen value as filtering", () => {
    expect(isActive({ id: "f", field: "F", op: "is", values: ["A"] })).toBe(true);
  });

  it("treats a half-typed range as not filtering yet", () => {
    expect(isActive({ id: "f", field: "F", op: "between", from: "", to: "" })).toBe(false);
    expect(isActive({ id: "f", field: "F", op: "between", from: "5", to: "" })).toBe(false);
  });

  it("does not mistake a zero bound for an empty one", () => {
    expect(isActive({ id: "f", field: "F", op: "between", from: 0, to: 0 })).toBe(true);
  });

  it("treats a relative window as always filtering", () => {
    expect(
      isActive({ id: "f", field: "F", op: "relativeDate", preset: "yearToDate" }),
    ).toBe(true);
  });
});

describe("effectiveFilters drops unfinished filters", () => {
  it("omits a filter with nothing selected", () => {
    const out = effectiveFilters({
      reportFilters: [{ id: "f1", field: "C.R", op: "is", values: [] }],
      visual: visual(),
    });
    expect(out).toEqual([]);
  });

  it("keeps the finished ones alongside", () => {
    const out = effectiveFilters({
      reportFilters: [
        { id: "f1", field: "C.R", op: "is", values: [] },
        { id: "f2", field: "C.S", op: "is", values: ["X"] },
      ],
      visual: visual(),
    });
    expect(out.map((f) => f.id)).toEqual(["f2"]);
  });
});

describe("sheetRequestsFor", () => {
  const page = (visuals: Visual[], filters: Filter[] = [], name = "Page 1"): Page => ({
    id: "p1",
    name,
    visuals,
    filters,
  });
  const wellsToQuery = (_type: string, wells: Record<string, string[]>) => ({
    dimensions: wells.axis ?? [],
    metrics: wells.values ?? [],
  });
  const titleOf = (v: Visual) => v.title || "Untitled";

  it("produces one sheet per visual", () => {
    const sheets = sheetRequestsFor({
      pages: [page([visual({ id: "v1", title: "A" }), visual({ id: "v2", title: "B" })])],
      reportFilters: [],
      hierarchies: [],
      drill: {},
      crossFilter: null,
      titleOf,
      wellsToQuery,
    });
    expect(sheets.map((s) => s.title)).toEqual(["A", "B"]);
  });

  it("carries the drilled level and names the path in context", () => {
    // The export must match the screen it was taken from.
    const sheets = sheetRequestsFor({
      pages: [
        page([
          visual({
            id: "v1",
            title: "Geo",
            wells: { axis: ["hierarchy:h1"], legend: [], values: ["ORDERS.TOTAL"] },
          }),
        ]),
      ],
      reportFilters: [],
      hierarchies: [GEO],
      drill: {
        v1: { hierarchyId: "h1", path: [{ field: "CUSTOMERS.COUNTRY", value: "US" }] },
      },
      crossFilter: null,
      titleOf,
      wellsToQuery,
    });
    expect(sheets[0].dimensions).toEqual(["CUSTOMERS.STATE"]);
    expect(sheets[0].filters.map((f) => f.field)).toContain("CUSTOMERS.COUNTRY");
    expect(sheets[0].context).toMatch(/Drilled into US/);
  });

  it("does not apply a cross-filter to the visual it came from", () => {
    const sheets = sheetRequestsFor({
      pages: [
        page([visual({ id: "v1", title: "Source" }), visual({ id: "v2", title: "Other" })]),
      ],
      reportFilters: [],
      hierarchies: [],
      drill: {},
      crossFilter: { sourceVisualId: "v1", field: "CUSTOMERS.REGION", value: "EAST" },
      titleOf,
      wellsToQuery,
    });
    expect(sheets[0].filters).toEqual([]);
    expect(sheets[0].context).toBe("");
    expect(sheets[1].filters.map((f) => f.field)).toEqual(["CUSTOMERS.REGION"]);
    expect(sheets[1].context).toMatch(/Filtered by CUSTOMERS.REGION/);
  });

  it("carries report-scope filters onto every sheet", () => {
    const sheets = sheetRequestsFor({
      pages: [page([visual({ id: "v1", title: "A" })])],
      reportFilters: [REGION_IS_EAST],
      hierarchies: [],
      drill: {},
      crossFilter: null,
      titleOf,
      wellsToQuery,
    });
    expect(sheets[0].filters).toEqual([REGION_IS_EAST]);
  });
});

describe("the wider operator set", () => {
  const at = (op: string, extra: Record<string, unknown> = {}) =>
    ({ id: "f1", field: "C.NAME", op, ...extra }) as unknown as Filter;

  it("treats an empty text pattern as not filtering yet", () => {
    // An empty LIKE pattern matches every row, which reads as no filter.
    expect(isActive(at("contains", { value: "" }))).toBe(false);
    expect(isActive(at("contains", { value: "ACME" }))).toBe(true);
  });

  it("treats zero as a real comparison bound", () => {
    expect(isActive(at("gt", { value: 0 }))).toBe(true);
    expect(isActive(at("gt", { value: "" }))).toBe(false);
  });

  it("counts a presence test as complete the moment it is chosen", () => {
    expect(isActive(at("isBlank"))).toBe(true);
    expect(isActive(at("isNotBlank"))).toBe(true);
  });

  it("needs both ends of a negated range", () => {
    expect(isActive(at("notBetween", { from: 1, to: "" }))).toBe(false);
    expect(isActive(at("notBetween", { from: 1, to: 9 }))).toBe(true);
  });

  it("describes every operator in a sentence", () => {
    expect(describeFilter(at("contains", { value: "ACME" }))).toBe(
      "C.NAME contains ACME",
    );
    expect(describeFilter(at("startsWith", { value: "A" }))).toBe(
      "C.NAME starts with A",
    );
    expect(describeFilter(at("gte", { value: 5 }))).toBe(
      "C.NAME is greater than or equal to 5",
    );
    expect(describeFilter(at("isBlank"))).toBe("C.NAME is blank");
    expect(describeFilter(at("notBetween", { from: 1, to: 9 }))).toBe(
      "C.NAME is not between 1 and 9",
    );
  });

  it("keeps an unfinished new-operator filter out of the composed set", () => {
    const out = effectiveFilters({
      reportFilters: [at("contains", { value: "" }), at("isBlank")],
      visual: visual(),
    });
    // The blank test survives; the empty pattern does not.
    expect(out.map((f) => f.op)).toEqual(["isBlank"]);
  });
});
