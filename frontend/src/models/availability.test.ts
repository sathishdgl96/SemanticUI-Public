import { describe, expect, it } from "vitest";
import { emptyWells, type Wells } from "../explorer/wells";
import {
  compositeAvailability,
  type CompositeViewDetail,
} from "./availability";

/** A model over two views. `sales` has ORDERS -> CUSTOMER and an
 *  unconnected PRODUCT table; `support` has TICKETS -> CLIENT. */
function model(): CompositeViewDetail {
  return {
    tables: [{ name: "Customer 360" }, { name: "sales" }, { name: "support" }],
    relationships: [],
    dimensions: [
      { table: "Customer 360", name: "Customer", dataType: "TEXT" },
      { table: "sales", name: "CUSTOMER.REGION", dataType: "TEXT" },
      { table: "sales", name: "PRODUCT.CATEGORY", dataType: "TEXT" },
      { table: "support", name: "TICKETS.PRIORITY", dataType: "TEXT" },
    ],
    metrics: [
      { table: "sales", name: "ORDERS.REVENUE", dataType: "NUMBER" },
      { table: "support", name: "TICKETS.TICKET_COUNT", dataType: "NUMBER" },
    ],
    facts: [],
    memberGraphs: [
      {
        alias: "sales",
        tables: [{ name: "ORDERS" }, { name: "CUSTOMER" }, { name: "PRODUCT" }],
        relationships: [
          {
            name: "r",
            table: "ORDERS",
            refTable: "CUSTOMER",
            foreignKey: ["CUSTOMER_ID"],
            refKey: ["CUSTOMER_ID"],
          },
        ],
      },
      {
        alias: "support",
        tables: [{ name: "TICKETS" }, { name: "CLIENT" }],
        relationships: [
          {
            name: "r2",
            table: "TICKETS",
            refTable: "CLIENT",
            foreignKey: ["CLIENT_ID"],
            refKey: ["CLIENT_ID"],
          },
        ],
      },
    ],
  };
}

function wells(over: Partial<Wells> = {}): Wells {
  return { ...emptyWells(), ...over };
}

describe("compositeAvailability", () => {
  it("blocks nothing when nothing is chosen", () => {
    expect(compositeAvailability(model(), wells()).size).toBe(0);
  });

  it("keeps a member's own join rule: a measure cannot break down what its view does not reach", () => {
    // ORDERS.REVENUE is measured per ORDERS, which reaches CUSTOMER but
    // not PRODUCT. Inside the branch this fails exactly as it would if
    // SALES_SV were queried on its own.
    const blocked = compositeAvailability(
      model(),
      wells({ values: ["sales.ORDERS.REVENUE"] }),
    );
    expect(blocked.has("sales.PRODUCT.CATEGORY")).toBe(true);
    expect(blocked.get("sales.PRODUCT.CATEGORY")).toMatch(/does not reach/i);
    // ...and leaves the one it does reach alone.
    expect(blocked.has("sales.CUSTOMER.REGION")).toBe(false);
  });

  it("blocks a measure that cannot break down a dimension already chosen", () => {
    const blocked = compositeAvailability(
      model(),
      wells({ axis: ["sales.PRODUCT.CATEGORY"] }),
    );
    expect(blocked.get("sales.ORDERS.REVENUE")).toMatch(/measured per ORDERS/);
  });

  it("does NOT let one member's graph rule out another member's field", () => {
    // The relaxed half: two views meet on a conformed dimension, so a
    // measure in one never constrains a field in the other.
    const blocked = compositeAvailability(
      model(),
      wells({ axis: ["Customer 360.Customer"], values: ["sales.ORDERS.REVENUE"] }),
    );
    expect(blocked.has("support.TICKETS.TICKET_COUNT")).toBe(false);
    expect(blocked.has("support.TICKETS.PRIORITY")).toBe(false);
  });

  it("blocks a second view until there is something to line the answers up on", () => {
    // The model's own rule, and the error the user was hitting only at
    // run time: two members, no shared dimension, nothing to join on.
    const blocked = compositeAvailability(
      model(),
      wells({ values: ["sales.ORDERS.REVENUE"] }),
    );
    expect(blocked.get("support.TICKETS.TICKET_COUNT")).toMatch(
      /shared dimension/i,
    );
  });

  it("unblocks the second view once a shared dimension is chosen", () => {
    const blocked = compositeAvailability(
      model(),
      wells({ axis: ["Customer 360.Customer"], values: ["sales.ORDERS.REVENUE"] }),
    );
    expect(blocked.has("support.TICKETS.TICKET_COUNT")).toBe(false);
  });

  it("never blocks a shared dimension", () => {
    // It is the thing that makes a cross-member question legal, so
    // greying it out would hide the way forward.
    const blocked = compositeAvailability(
      model(),
      wells({ values: ["sales.ORDERS.REVENUE"] }),
    );
    expect(blocked.has("Customer 360.Customer")).toBe(false);
  });

  it("never blocks what is already chosen", () => {
    const blocked = compositeAvailability(
      model(),
      wells({ axis: ["sales.PRODUCT.CATEGORY"], values: ["sales.ORDERS.REVENUE"] }),
    );
    expect(blocked.has("sales.PRODUCT.CATEGORY")).toBe(false);
    expect(blocked.has("sales.ORDERS.REVENUE")).toBe(false);
  });

  it("says nothing when the model carries no member graphs", () => {
    // An older describe, or one where no member could be read: refusing
    // everything would be worse than offering it and letting the server
    // answer.
    const detail = model();
    delete detail.memberGraphs;
    expect(
      compositeAvailability(detail, wells({ values: ["sales.ORDERS.REVENUE"] })).size,
    ).toBe(0);
  });
});

describe("the TPC-H shape that reported this", () => {
  /** LINEITEMS is the fine-grained fact referencing both ORDERS and PART,
   *  so neither of those reaches the other: ORDER_COUNT is per ORDERS and
   *  cannot be broken down by PART.BRAND. */
  function tpch(): CompositeViewDetail {
    return {
      tables: [{ name: "Model" }, { name: "sales" }],
      relationships: [],
      dimensions: [
        { table: "Model", name: "Customer", dataType: "TEXT" },
        { table: "sales", name: "PART.BRAND", dataType: "TEXT" },
        { table: "sales", name: "CUSTOMER.NAME", dataType: "TEXT" },
      ],
      metrics: [
        { table: "sales", name: "ORDERS.ORDER_COUNT", dataType: "NUMBER" },
        { table: "sales", name: "LINEITEMS.TOTAL_QUANTITY", dataType: "NUMBER" },
      ],
      facts: [],
      memberGraphs: [
        {
          alias: "sales",
          tables: [
            { name: "LINEITEMS" },
            { name: "ORDERS" },
            { name: "PART" },
            { name: "CUSTOMER" },
          ],
          relationships: [
            {
              name: "li_to_orders",
              table: "LINEITEMS",
              refTable: "ORDERS",
              foreignKey: ["ORDER_ID"],
              refKey: ["ORDER_ID"],
            },
            {
              name: "li_to_part",
              table: "LINEITEMS",
              refTable: "PART",
              foreignKey: ["PART_ID"],
              refKey: ["PART_ID"],
            },
            {
              name: "orders_to_customer",
              table: "ORDERS",
              refTable: "CUSTOMER",
              foreignKey: ["CUSTOMER_ID"],
              refKey: ["CUSTOMER_ID"],
            },
          ],
        },
      ],
    };
  }

  it("greys PART.BRAND once ORDER_COUNT is chosen", () => {
    const blocked = compositeAvailability(
      tpch(),
      wells({ values: ["sales.ORDERS.ORDER_COUNT"] }),
    );
    expect(blocked.has("sales.PART.BRAND")).toBe(true);
    // ...and leaves the one ORDERS does reach alone.
    expect(blocked.has("sales.CUSTOMER.NAME")).toBe(false);
  });

  it("greys ORDER_COUNT once PART.BRAND is chosen", () => {
    // The same rule from the other side: whichever was picked first, the
    // pair is never offered.
    const blocked = compositeAvailability(
      tpch(),
      wells({ axis: ["sales.PART.BRAND"] }),
    );
    expect(blocked.get("sales.ORDERS.ORDER_COUNT")).toMatch(/measured per ORDERS/);
    // The measure that CAN break it down stays offered -- it is the way
    // out of the refusal.
    expect(blocked.has("sales.LINEITEMS.TOTAL_QUANTITY")).toBe(false);
  });
});
