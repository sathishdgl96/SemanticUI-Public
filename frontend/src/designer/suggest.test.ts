import { describe, expect, it } from "vitest";
import type { CompositeDefinition } from "../api/composites";
import type { SemanticViewDetail } from "../api/types";
import { ghostKey, ghostsFor } from "./suggest";

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
function detail(): Record<string, SemanticViewDetail> {
  return {
    sales: {
      tables: [{ name: "CUSTOMER" }],
      relationships: [],
      dimensions: [
        { table: "CUSTOMER", name: "CUSTOMER_ID", dataType: "TEXT" },
        { table: "CUSTOMER", name: "REGION", dataType: "TEXT" },
      ],
      metrics: [],
      facts: [],
    },
    support: {
      tables: [{ name: "CLIENT" }],
      relationships: [],
      dimensions: [{ table: "CLIENT", name: "CUSTOMER_ID", dataType: "TEXT" }],
      metrics: [],
      facts: [],
    },
  };
}

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
    delete (alone as Record<string, unknown>).support;
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
