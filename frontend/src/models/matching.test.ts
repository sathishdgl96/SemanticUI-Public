import { describe, expect, it } from "vitest";
import type { SemanticViewDetail } from "../api/types";
import {
  dimensionColumns,
  dimensionTables,
  looksLikeKey,
  prettyName,
  suggestSharedDimensions,
} from "./matching";

function view(dimensions: [string, string][]): SemanticViewDetail {
  return {
    tables: [],
    relationships: [],
    dimensions: dimensions.map(([table, name]) => ({
      table,
      name,
      dataType: "TEXT",
    })),
    metrics: [],
    facts: [],
  };
}

const members = [
  { alias: "sales", database: "D", schema: "S", view: "SALES_SV" },
  { alias: "support", database: "D", schema: "S", view: "SUPPORT_SV" },
];

describe("prettyName", () => {
  it("drops the key suffix, because it says how not what", () => {
    expect(prettyName("CUSTOMER_ID")).toBe("Customer");
    expect(prettyName("CLIENT_KEY")).toBe("Client");
  });

  it("reads a multi-word column as words", () => {
    expect(prettyName("ORDER_MONTH")).toBe("Order month");
  });
});

describe("looksLikeKey", () => {
  it("recognises the shapes a join is usually on", () => {
    expect(looksLikeKey("CUSTOMER_ID")).toBe(true);
    expect(looksLikeKey("PRODUCT_CODE")).toBe(true);
    expect(looksLikeKey("REGION")).toBe(false);
  });
});

describe("suggestSharedDimensions", () => {
  it("suggests a column both views name the same way", () => {
    const found = suggestSharedDimensions(members, {
      sales: view([["CUSTOMER", "CUSTOMER_ID"]]),
      support: view([["CLIENT", "CUSTOMER_ID"]]),
    });
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("Customer");
    expect(found[0].bindings).toEqual({
      sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
      support: { table: "CLIENT", column: "CUSTOMER_ID" },
    });
  });

  it("ranks a shared key above a shared plain column", () => {
    const found = suggestSharedDimensions(members, {
      sales: view([
        ["CUSTOMER", "CUSTOMER_ID"],
        ["CUSTOMER", "REGION"],
      ]),
      support: view([
        ["CLIENT", "CUSTOMER_ID"],
        ["CLIENT", "REGION"],
      ]),
    });
    expect(found.map((c) => c.name)).toEqual(["Customer", "Region"]);
    expect(found[0].reason).toMatch(/key column/i);
  });

  it("matches across a differing key suffix, and says the evidence is weaker", () => {
    const found = suggestSharedDimensions(members, {
      sales: view([["CUSTOMER", "CUSTOMER_ID"]]),
      support: view([["CLIENT", "CUSTOMER_KEY"]]),
    });
    expect(found).toHaveLength(1);
    expect(found[0].reason).toMatch(/similar/i);
    expect(found[0].bindings.support.column).toBe("CUSTOMER_KEY");
  });

  it("does NOT connect differently-named columns", () => {
    // CUSTOMER_ID and CLIENT_ID may well be the same thing, but nothing in
    // the metadata says so. Guessing from a shared data type would fill
    // this list with noise and teach people to click past it.
    const found = suggestSharedDimensions(members, {
      sales: view([["CUSTOMER", "CUSTOMER_ID"]]),
      support: view([["CLIENT", "CLIENT_ID"]]),
    });
    expect(found).toEqual([]);
  });

  it("needs at least two views to have it", () => {
    const found = suggestSharedDimensions(members, {
      sales: view([["CUSTOMER", "ONLY_HERE"]]),
      support: view([["CLIENT", "SOMETHING_ELSE"]]),
    });
    expect(found).toEqual([]);
  });

  it("leaves out what is already mapped", () => {
    const found = suggestSharedDimensions(
      members,
      {
        sales: view([["CUSTOMER", "CUSTOMER_ID"]]),
        support: view([["CLIENT", "CUSTOMER_ID"]]),
      },
      [
        {
          name: "Customer",
          bindings: {
            sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
            support: { table: "CLIENT", column: "CUSTOMER_ID" },
          },
        },
      ],
    );
    expect(found).toEqual([]);
  });

  it("offers a column once per view even when two tables carry the name", () => {
    // A name on two tables of one view is ambiguous; picking one silently
    // is the guess this module exists not to make.
    const found = suggestSharedDimensions(members, {
      sales: view([
        ["CUSTOMER", "REGION"],
        ["STORE", "REGION"],
      ]),
      support: view([["CLIENT", "REGION"]]),
    });
    expect(found).toHaveLength(1);
    expect(Object.keys(found[0].bindings)).toHaveLength(2);
  });

  it("puts a dimension more views share first", () => {
    const three = [...members, { alias: "web", database: "D", schema: "S", view: "WEB_SV" }];
    const found = suggestSharedDimensions(three, {
      sales: view([
        ["CUSTOMER", "CUSTOMER_ID"],
        ["ORDERS", "ORDER_MONTH"],
      ]),
      support: view([
        ["CLIENT", "CUSTOMER_ID"],
        ["TICKETS", "ORDER_MONTH"],
      ]),
      web: view([["VISITS", "CUSTOMER_ID"]]),
    });
    expect(found[0].name).toBe("Customer");
    expect(Object.keys(found[0].bindings)).toHaveLength(3);
  });

  it("says nothing when a view could not be described", () => {
    const found = suggestSharedDimensions(members, {
      sales: view([["CUSTOMER", "CUSTOMER_ID"]]),
      support: undefined,
    });
    expect(found).toEqual([]);
  });
});

describe("dropdown sources", () => {
  it("lists the tables that actually carry dimensions, in describe order", () => {
    const detail = view([
      ["ORDERS", "ORDER_MONTH"],
      ["CUSTOMER", "REGION"],
      ["ORDERS", "CHANNEL"],
    ]);
    expect(dimensionTables(detail)).toEqual(["ORDERS", "CUSTOMER"]);
  });

  it("lists one table's columns", () => {
    const detail = view([
      ["ORDERS", "ORDER_MONTH"],
      ["CUSTOMER", "REGION"],
    ]);
    expect(dimensionColumns(detail, "ORDERS")).toEqual(["ORDER_MONTH"]);
  });
});
