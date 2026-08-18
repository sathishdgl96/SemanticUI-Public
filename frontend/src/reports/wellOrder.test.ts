import { describe, expect, it } from "vitest";
import type { Visual } from "../api/types";
import { moveWellRef } from "./wellOrder";

function matrix(): Visual {
  return {
    id: "v1",
    type: "matrix",
    title: "",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells: {
      rows: ["C.REGION", "C.SEGMENT", "C.CITY"],
      columns: [],
      values: ["O.REV"],
    },
    options: {},
    filters: [],
  };
}

describe("moveWellRef", () => {
  it("reorders within a well, in front of the target chip", () => {
    const next = moveWellRef(matrix(), "rows", "C.CITY", "rows", "C.REGION");
    expect(next.wells.rows).toEqual(["C.CITY", "C.REGION", "C.SEGMENT"]);
  });

  it("moves to the end when there is no target chip", () => {
    const next = moveWellRef(matrix(), "rows", "C.REGION", "rows");
    expect(next.wells.rows).toEqual(["C.SEGMENT", "C.CITY", "C.REGION"]);
  });

  it("relocates a field between wells of the same kind", () => {
    const next = moveWellRef(matrix(), "rows", "C.SEGMENT", "columns");
    expect(next.wells.rows).toEqual(["C.REGION", "C.CITY"]);
    expect(next.wells.columns).toEqual(["C.SEGMENT"]);
  });

  it("refuses a full target well", () => {
    const start = moveWellRef(matrix(), "rows", "C.SEGMENT", "columns");
    // columns holds max one dimension on a matrix.
    const next = moveWellRef(start, "rows", "C.CITY", "columns");
    expect(next).toBe(start);
  });

  it("refuses a kind mismatch", () => {
    const input = matrix();
    const next = moveWellRef(input, "rows", "C.REGION", "values");
    expect(next).toBe(input);
  });
});
