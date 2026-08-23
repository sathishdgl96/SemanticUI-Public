import { describe, expect, it } from "vitest";
import { columnIndexOf, fieldName } from "./fieldName";

describe("fieldName", () => {
  it("is unchanged for a single view's two-part reference", () => {
    // The whole reason this is safe to change everywhere.
    expect(fieldName("CUSTOMER.REGION")).toBe("REGION");
    expect(fieldName("ORDERS.REVENUE")).toBe("ORDERS.REVENUE".slice(7));
  });

  it("keeps the table for a model's member field", () => {
    // Taking the SECOND segment returned "ORDERS" -- the member's table,
    // never a column in the result -- and every chart drew nothing.
    expect(fieldName("sales.ORDERS.REVENUE")).toBe("ORDERS.REVENUE");
  });

  it("leaves a shared dimension as itself", () => {
    expect(fieldName("Customer 360.Customer")).toBe("Customer");
  });

  it("returns a reference with no dot unchanged", () => {
    expect(fieldName("REVENUE")).toBe("REVENUE");
  });
});

describe("columnIndexOf", () => {
  const columns = [{ name: "Customer" }, { name: "ORDERS.REVENUE" }];

  it("finds a model member's column", () => {
    expect(columnIndexOf(columns, "sales.ORDERS.REVENUE")).toBe(1);
  });

  it("matches case-insensitively, because Snowflake answers in its own", () => {
    expect(columnIndexOf(columns, "CUSTOMER 360.customer")).toBe(0);
  });

  it("says -1 rather than guessing", () => {
    expect(columnIndexOf(columns, "sales.GONE")).toBe(-1);
  });
});
