import { describe, expect, it } from "vitest";
import type { CompositeDefinition } from "../api/composites";
import type { CompositeViewDetail } from "../models/availability";
import { ghostKey, ghostsFor, memberDetails } from "./suggest";

function definition(over: Partial<CompositeDefinition> = {}): CompositeDefinition {
  return {
    schemaVersion: 1,
    name: "Customer 360",
    members: [
      { alias: "sales", database: "D", schema: "S", view: "SALES_SV" },
      { alias: "support", database: "D", schema: "S", view: "SUPPORT_SV" },
    ],
    sharedDimensions: [],
    derivedMetrics: [],
    joinType: "full",
    crossFilter: "semi",
    ...over,
  };
}

/** Both views know CUSTOMER_ID; only sales knows REGION. */
function detail(): CompositeViewDetail {
  return {
    tables: [{ name: "Customer 360" }, { name: "sales" }, { name: "support" }],
    relationships: [],
    dimensions: [
      { table: "sales", name: "CUSTOMER.CUSTOMER_ID", dataType: "TEXT" },
      { table: "sales", name: "CUSTOMER.REGION", dataType: "TEXT" },
      { table: "support", name: "CLIENT.CUSTOMER_ID", dataType: "TEXT" },
    ],
    metrics: [],
    facts: [],
    memberGraphs: [
      { alias: "sales", tables: [{ name: "CUSTOMER" }], relationships: [] },
      { alias: "support", tables: [{ name: "CLIENT" }], relationships: [] },
    ],
  };
}

describe("memberDetails", () => {
  it("unflattens the model's field list back into one describe per view", () => {
    // So auto-detect costs no extra request, and the canvas and the form
    // suggest from exactly the same data.
    const details = memberDetails(definition(), detail());
    expect(details.sales.dimensions).toEqual([
      { table: "CUSTOMER", name: "CUSTOMER_ID", dataType: "TEXT" },
      { table: "CUSTOMER", name: "REGION", dataType: "TEXT" },
    ]);
    expect(details.support.dimensions).toEqual([
      { table: "CLIENT", name: "CUSTOMER_ID", dataType: "TEXT" },
    ]);
  });

  it("leaves a shared dimension out — it is already mapped, not a candidate", () => {
    const withShared = detail();
    withShared.dimensions.push({
      table: "Customer 360",
      name: "Customer",
      dataType: "TEXT",
    });
    const details = memberDetails(definition(), withShared);
    expect(Object.keys(details).sort()).toEqual(["sales", "support"]);
  });

  it("carries each view's own graph through, for the reachability rules", () => {
    const details = memberDetails(definition(), detail());
    expect(details.sales.tables).toEqual([{ name: "CUSTOMER" }]);
  });
});

describe("ghostsFor", () => {
  it("suggests the column both views name the same way", () => {
    const ghosts = ghostsFor(definition(), detail());
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].name).toBe("Customer");
    expect(ghosts[0].bindings).toEqual({
      sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
      support: { table: "CLIENT", column: "CUSTOMER_ID" },
    });
    expect(ghosts[0].reason).toMatch(/key column/i);
  });

  it("stops suggesting what is already mapped", () => {
    const mapped = definition({
      sharedDimensions: [
        {
          name: "Customer",
          bindings: {
            sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
            support: { table: "CLIENT", column: "CUSTOMER_ID" },
          },
        },
      ],
    });
    expect(ghostsFor(mapped, detail())).toEqual([]);
  });

  it("stops suggesting one that was dismissed", () => {
    const ghosts = ghostsFor(definition(), detail());
    const dismissed = new Set([ghostKey(ghosts[0])]);
    expect(ghostsFor(definition(), detail(), dismissed)).toEqual([]);
  });

  it("suggests nothing when only one view knows a column", () => {
    const alone = detail();
    alone.dimensions = alone.dimensions.filter((d) => d.table === "sales");
    expect(ghostsFor(definition(), alone)).toEqual([]);
  });
});

describe("ghostKey", () => {
  it("is the same whichever order the bindings arrive in", () => {
    // A dismissal has to survive the re-suggestion that follows every
    // edit, and the matcher does not promise an order.
    const a = ghostKey({
      name: "Customer",
      reason: "",
      bindings: {
        sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
        support: { table: "CLIENT", column: "CUSTOMER_ID" },
      },
    });
    const b = ghostKey({
      name: "Customer",
      reason: "",
      bindings: {
        support: { table: "CLIENT", column: "CUSTOMER_ID" },
        sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
      },
    });
    expect(a).toBe(b);
  });
});
