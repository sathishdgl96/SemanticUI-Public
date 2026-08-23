import { describe, expect, it } from "vitest";
import { groupViews } from "./groupViews";

describe("groupViews", () => {
  it("groups by database then schema", () => {
    const grouped = groupViews([
      { name: "SALES", database: "ANALYTICS", schema: "PUBLIC", comment: null },
      { name: "OPS", database: "ANALYTICS", schema: "INTERNAL", comment: null },
      { name: "HR", database: "PEOPLE", schema: "PUBLIC", comment: null },
    ]);
    expect(Object.keys(grouped)).toEqual(["ANALYTICS", "PEOPLE"]);
    expect(Object.keys(grouped.ANALYTICS)).toEqual(["PUBLIC", "INTERNAL"]);
    expect(grouped.ANALYTICS.PUBLIC[0].name).toBe("SALES");
  });
});
