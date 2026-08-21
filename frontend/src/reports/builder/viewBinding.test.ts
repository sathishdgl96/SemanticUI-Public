import { describe, expect, it } from "vitest";
import { describeUrl, queryUrl, valuesUrl } from "./viewBinding";

const view = { database: "ANALYTICS", schema: "PUBLIC", name: "SALES" };
const model = { database: "", schema: "", name: "Customer 360", compositeId: "m1" };

describe("where a source's requests go", () => {
  it("routes a view to the semantic-view endpoints", () => {
    expect(describeUrl(view)).toBe("/api/semantic-views/ANALYTICS/PUBLIC/SALES");
    expect(queryUrl(view)).toBe("/api/query/semantic");
    expect(valuesUrl(view)).toBe("/api/semantic-views/ANALYTICS/PUBLIC/SALES/values");
  });

  it("routes a model to its own, on all three", () => {
    // All three have to move together: a describe from the model and
    // values from a view it does not have is how filters stopped loading.
    expect(describeUrl(model)).toBe("/api/composites/m1/describe");
    expect(queryUrl(model)).toBe("/api/composites/m1/query");
    expect(valuesUrl(model)).toBe("/api/composites/m1/values");
  });


  it("escapes what goes into a URL", () => {
    expect(describeUrl({ ...view, name: "A B" })).toContain("A%20B");
    expect(valuesUrl({ ...model, compositeId: "a/b" })).toContain("a%2Fb");
  });
});
