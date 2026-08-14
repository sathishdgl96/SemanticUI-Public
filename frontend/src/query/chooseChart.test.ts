import { describe, expect, it } from "vitest";
import { chooseChart } from "./chooseChart";

describe("chooseChart", () => {
  it("bar for 1 dimension + metrics", () => {
    expect(chooseChart(1, 1, "TEXT")).toBe("bar");
    expect(chooseChart(1, 3, "FIXED")).toBe("bar");
  });
  it("line when the dimension is date-like", () => {
    expect(chooseChart(1, 1, "DATE")).toBe("line");
    expect(chooseChart(1, 2, "TIMESTAMP_NTZ")).toBe("line");
  });
  it("none for 0 or 2+ dimensions or no metrics", () => {
    expect(chooseChart(0, 2)).toBe("none");
    expect(chooseChart(2, 1, "TEXT")).toBe("none");
    expect(chooseChart(1, 0, "TEXT")).toBe("none");
  });
});
