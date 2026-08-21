import { describe, expect, it } from "vitest";
import type { CompositeDefinition } from "../api/composites";
import type { SemanticViewDetail } from "../api/types";
import { compositeDetailFromDraft, folderName } from "./fromDraft";

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

function view(
  dimensions: [string, string][],
  metrics: [string, string][] = [],
): SemanticViewDetail {
  return {
    tables: [...new Set(dimensions.map(([t]) => t))].map((name) => ({ name })),
    relationships: [],
    dimensions: dimensions.map(([table, name]) => ({ table, name, dataType: "TEXT" })),
    metrics: metrics.map(([table, name]) => ({ table, name, dataType: "NUMBER" })),
    facts: [],
  };
}

const describes = {
  sales: view([["CUSTOMER", "CUSTOMER_ID"], ["CUSTOMER", "REGION"]], [
    ["ORDERS", "REVENUE"],
  ]),
  support: view([["CLIENT", "CLIENT_ID"]], [["TICKETS", "TICKET_COUNT"]]),
};

describe("compositeDetailFromDraft", () => {
  it("describes a view the moment it is added, before anything is saved", () => {
    // The whole point: /describe answers for the model AS SAVED, so a
    // freshly added view came back with no fields and its container
    // reported itself unreadable while sitting there on screen.
    const detail = compositeDetailFromDraft(definition(), describes);
    expect(detail.memberGraphs?.map((g) => g.alias)).toEqual(["sales", "support"]);
    expect(detail.memberErrors).toEqual({});
  });

  it("names a member's fields with the member in front", () => {
    const detail = compositeDetailFromDraft(definition(), describes);
    const names = detail.dimensions.map((d) => `${d.table}.${d.name}`);
    expect(names).toContain("sales.CUSTOMER.REGION");
    expect(detail.metrics.map((m) => `${m.table}.${m.name}`)).toContain(
      "support.TICKETS.TICKET_COUNT",
    );
  });

  it("puts shared dimensions under the model's own name", () => {
    const detail = compositeDetailFromDraft(
      definition({
        sharedDimensions: [
          {
            name: "Customer",
            bindings: {
              sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
              support: { table: "CLIENT", column: "CLIENT_ID" },
            },
          },
        ],
      }),
      describes,
    );
    expect(detail.dimensions).toContainEqual({
      table: "Customer 360",
      name: "Customer",
      dataType: "TEXT",
    });
  });

  it("does not offer a conformed column twice", () => {
    // Two ways to group by one thing answer differently depending which
    // was dragged.
    const detail = compositeDetailFromDraft(
      definition({
        sharedDimensions: [
          {
            name: "Customer",
            bindings: {
              sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
              support: { table: "CLIENT", column: "CLIENT_ID" },
            },
          },
        ],
      }),
      describes,
    );
    const names = detail.dimensions.map((d) => `${d.table}.${d.name}`);
    expect(names).not.toContain("sales.CUSTOMER.CUSTOMER_ID");
    expect(names).toContain("sales.CUSTOMER.REGION");
  });

  it("carries each view's own graph, for the reachability rules", () => {
    const detail = compositeDetailFromDraft(definition(), describes);
    const sales = detail.memberGraphs!.find((g) => g.alias === "sales")!;
    expect(sales.tables).toEqual([{ name: "CUSTOMER" }]);
  });

  it("distinguishes a view still loading from one that was refused", () => {
    // "Still reading" and "Snowflake said no" are different states and
    // one of them resolves itself; reporting both as unreadable is what
    // sent somebody looking at grants.
    const partial = compositeDetailFromDraft(definition(), { sales: describes.sales });
    expect(partial.memberErrors?.support).toMatch(/still reading/i);

    const refused = compositeDetailFromDraft(
      definition(),
      { sales: describes.sales },
      ["support"],
    );
    expect(refused.memberErrors?.support).toMatch(/refused|no longer exists/i);
  });

  it("lists derived metrics under the model", () => {
    const detail = compositeDetailFromDraft(
      definition({
        derivedMetrics: [
          {
            name: "Revenue per ticket",
            expr: {
              op: "/",
              left: { metric: "sales:ORDERS.REVENUE" },
              right: { metric: "support:TICKETS.TICKET_COUNT" },
            },
          },
        ],
      }),
      describes,
    );
    expect(detail.metrics).toContainEqual({
      table: "Customer 360",
      name: "Revenue per ticket",
      dataType: null,
    });
  });

  it("is empty but valid for a model with no views", () => {
    const detail = compositeDetailFromDraft(definition({ members: [] }), {});
    expect(detail.memberGraphs).toEqual([]);
    expect(detail.dimensions).toEqual([]);
  });
});

describe("folderName", () => {
  it("is the model's own name", () => {
    expect(folderName(definition())).toBe("Customer 360");
  });

  it("keeps clear of a member alias, so a reference stays unambiguous", () => {
    expect(folderName(definition({ name: "sales" }))).not.toBe("sales");
  });
});
