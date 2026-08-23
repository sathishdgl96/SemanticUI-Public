import { describe, expect, it } from "vitest";
import type { CompositeDefinition } from "../api/composites";
import { dimensionAt, relate, rename, unrelate } from "./edits";

function model(over: Partial<CompositeDefinition> = {}): CompositeDefinition {
  return {
    schemaVersion: 1,
    name: "Customer 360",
    members: [
      { alias: "sales", database: "D", schema: "S", view: "SALES_SV" },
      { alias: "support", database: "D", schema: "S", view: "SUPPORT_SV" },
      { alias: "web", database: "D", schema: "S", view: "WEB_SV" },
    ],
    sharedDimensions: [],
    derivedMetrics: [],
    joinType: "full",
    crossFilter: "semi",
    ...over,
  };
}

const salesCustomer = { alias: "sales", table: "CUSTOMER", column: "CUSTOMER_ID" };
const supportClient = { alias: "support", table: "CLIENT", column: "CLIENT_ID" };
const webVisits = { alias: "web", table: "VISITS", column: "CUSTOMER_ID" };

function withCustomer(): CompositeDefinition {
  return model({
    sharedDimensions: [
      {
        name: "Customer",
        bindings: {
          sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
          support: { table: "CLIENT", column: "CLIENT_ID" },
        },
      },
    ],
  });
}

describe("relate", () => {
  it("makes a shared dimension from two unmapped columns, named from the column", () => {
    const result = relate(model(), salesCustomer, supportClient);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.sharedDimensions).toEqual([
      {
        name: "Customer",
        bindings: {
          sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
          support: { table: "CLIENT", column: "CLIENT_ID" },
        },
      },
    ]);
  });

  it("adds a third view to the dimension one end already belongs to", () => {
    // How a model reaches three views without collecting pairwise
    // mappings that would each have to be kept in step.
    const result = relate(withCustomer(), webVisits, salesCustomer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.sharedDimensions).toHaveLength(1);
    expect(Object.keys(result.definition.sharedDimensions[0].bindings).sort()).toEqual(
      ["sales", "support", "web"],
    );
  });

  it("refuses a drag within one view, and says why", () => {
    const result = relate(model(), salesCustomer, {
      alias: "sales",
      table: "ORDERS",
      column: "CUSTOMER_ID",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/Snowflake/);
  });

  it("refuses to merge two named concepts", () => {
    const definition = model({
      sharedDimensions: [
        {
          name: "Customer",
          bindings: {
            sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
            web: { table: "VISITS", column: "CUSTOMER_ID" },
          },
        },
        {
          name: "Client",
          bindings: {
            support: { table: "CLIENT", column: "CLIENT_ID" },
            web: { table: "VISITS", column: "CLIENT_ID" },
          },
        },
      ],
    });
    const result = relate(definition, salesCustomer, supportClient);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/Customer/);
    expect(result.reason).toMatch(/Client/);
  });

  it("refuses a second column from a view the dimension already reads", () => {
    // A view holds one column per shared dimension; two would make
    // "group by Customer" ambiguous in that branch.
    const result = relate(withCustomer(), supportClient, {
      alias: "sales",
      table: "ORDERS",
      column: "BUYER_ID",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/one column per shared dimension/i);
  });

  it("says so when the two are already the same thing", () => {
    const result = relate(withCustomer(), salesCustomer, supportClient);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/already Customer/);
  });

  it("does not reuse a name another dimension has", () => {
    const definition = model({
      sharedDimensions: [
        {
          name: "Customer",
          bindings: {
            support: { table: "CLIENT", column: "CLIENT_ID" },
            web: { table: "VISITS", column: "CLIENT_ID" },
          },
        },
      ],
    });
    const result = relate(definition, salesCustomer, {
      alias: "support",
      table: "TICKETS",
      column: "CUSTOMER_ID",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.sharedDimensions[1].name).toBe("Customer 2");
  });

  it("leaves the definition it was given alone", () => {
    // Every gesture returns a new definition; mutating in place would
    // make the Fields tab show changes the Design tab has not committed.
    const before = withCustomer();
    const snapshot = JSON.stringify(before);
    relate(before, webVisits, salesCustomer);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("dimensionAt", () => {
  it("finds the dimension a column takes part in", () => {
    expect(dimensionAt(withCustomer(), salesCustomer)?.name).toBe("Customer");
  });

  it("is undefined for a column that is mapped nowhere", () => {
    expect(dimensionAt(withCustomer(), webVisits)).toBeUndefined();
  });

  it("does not match the same column name in another view", () => {
    // web.VISITS.CUSTOMER_ID spells it the same way sales does; that is a
    // coincidence until somebody maps it.
    expect(
      dimensionAt(withCustomer(), {
        alias: "web",
        table: "CUSTOMER",
        column: "CUSTOMER_ID",
      }),
    ).toBeUndefined();
  });
});

describe("rename", () => {
  it("renames one dimension", () => {
    const result = rename(withCustomer(), 0, "Account");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.sharedDimensions[0].name).toBe("Account");
  });

  it("refuses an empty name", () => {
    const result = rename(withCustomer(), 0, "   ");
    expect(result.ok).toBe(false);
  });

  it("refuses a name another dimension has", () => {
    const definition = model({
      sharedDimensions: [
        ...withCustomer().sharedDimensions,
        {
          name: "Month",
          bindings: {
            sales: { table: "ORDERS", column: "ORDER_MONTH" },
            support: { table: "TICKETS", column: "OPENED_MONTH" },
          },
        },
      ],
    });
    const result = rename(definition, 1, "Customer");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/already a Customer/);
  });
});

describe("unrelate", () => {
  it("removes the whole dimension when only two views held it", () => {
    // One binding left is not a shared dimension; leaving it would save a
    // model the server refuses.
    const result = unrelate(withCustomer(), 0, "support");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.sharedDimensions).toEqual([]);
  });

  it("drops one binding of a three-way dimension and keeps the rest", () => {
    const three = relate(withCustomer(), webVisits, salesCustomer);
    expect(three.ok).toBe(true);
    if (!three.ok) return;
    const result = unrelate(three.definition, 0, "web");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.definition.sharedDimensions[0].bindings).sort()).toEqual(
      ["sales", "support"],
    );
  });

  it("takes a label with the binding it described", () => {
    const definition = model({
      sharedDimensions: [
        {
          name: "Customer",
          bindings: {
            sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
            support: { table: "CLIENT", column: "CLIENT_ID" },
            web: { table: "VISITS", column: "CUSTOMER_ID" },
          },
          labels: { web: { table: "VISITS", column: "HANDLE" } },
        },
      ],
    });
    const result = unrelate(definition, 0, "web");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.sharedDimensions[0].labels).toEqual({});
  });

  it("removes the dimension outright when no view is named", () => {
    const result = unrelate(withCustomer(), 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.sharedDimensions).toEqual([]);
  });

  it("says so when the mapping is already gone", () => {
    expect(unrelate(model(), 3).ok).toBe(false);
  });
});
