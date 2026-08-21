import { describe, expect, it } from "vitest";
import type { CompositeDefinition } from "../api/composites";
import type { CompositeViewDetail } from "../models/availability";
import {
  buildDesigner,
  columnHandle,
  parseHandle,
  type DesignerEdge,
  type DesignerNode,
} from "./layout";
import { PALETTE } from "./palette";

function definition(over: Partial<CompositeDefinition> = {}): CompositeDefinition {
  return {
    schemaVersion: 1,
    name: "Customer 360",
    members: [
      { alias: "sales", database: "D", schema: "S", view: "SALES_SV" },
      { alias: "support", database: "D", schema: "S", view: "SUPPORT_SV" },
    ],
    sharedDimensions: [
      {
        name: "Customer",
        bindings: {
          sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
          support: { table: "CLIENT", column: "CLIENT_ID" },
        },
      },
    ],
    derivedMetrics: [],
    joinType: "full",
    crossFilter: "semi",
    ...over,
  };
}

function detail(): CompositeViewDetail {
  return {
    tables: [{ name: "Customer 360" }, { name: "sales" }, { name: "support" }],
    relationships: [],
    dimensions: [
      { table: "Customer 360", name: "Customer", dataType: "TEXT" },
      { table: "sales", name: "CUSTOMER.CUSTOMER_ID", dataType: "TEXT" },
      { table: "sales", name: "CUSTOMER.REGION", dataType: "TEXT" },
      { table: "support", name: "CLIENT.CLIENT_ID", dataType: "TEXT" },
    ],
    metrics: [
      { table: "sales", name: "ORDERS.REVENUE", dataType: "NUMBER" },
      { table: "support", name: "TICKETS.TICKET_COUNT", dataType: "NUMBER" },
    ],
    facts: [],
    memberGraphs: [
      {
        alias: "sales",
        tables: [{ name: "ORDERS" }, { name: "CUSTOMER" }],
        relationships: [
          {
            name: "orders_to_customer",
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
            name: "tickets_to_client",
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

const backdrops = (nodes: DesignerNode[]) => nodes.filter((n) => n.type === "backdrop");
const tables = (nodes: DesignerNode[]) => nodes.filter((n) => n.type === "designerTable");
const kind = (edges: DesignerEdge[], want: string) =>
  edges.filter((e) => e.data?.kind === want);

describe("buildDesigner", () => {
  it("draws one backdrop per member view", () => {
    const { nodes } = buildDesigner(definition(), detail());
    expect(backdrops(nodes).map((n) => n.id)).toEqual(["sales", "support"]);
  });

  it("gives each view its own colour, by position", () => {
    // By position, not by hashing the alias: renaming a view must not
    // silently recolour half the canvas.
    const { nodes } = buildDesigner(definition(), detail());
    const [first, second] = backdrops(nodes);
    expect(first.data.colour).toEqual(PALETTE[0]);
    expect(second.data.colour).toEqual(PALETTE[1]);
  });

  it("shows no tables while every view is collapsed", () => {
    const { nodes } = buildDesigner(definition(), detail());
    expect(tables(nodes)).toEqual([]);
  });

  it("still draws the conformed edge when both views are collapsed", () => {
    // The property the whole design rests on: collapsed is smaller, not
    // blind. An edge with nowhere to land is why this is tested first.
    const { edges } = buildDesigner(definition(), detail());
    const conformed = kind(edges, "conformed");
    expect(conformed).toHaveLength(1);
    expect(conformed[0].source).toBe("sales");
    expect(conformed[0].target).toBe("support");
    expect(conformed[0].data?.label).toBe("Customer");
  });

  it("lists the conformed columns on a collapsed backdrop, so the edge has an anchor", () => {
    const { nodes } = buildDesigner(definition(), detail());
    const sales = backdrops(nodes).find((n) => n.id === "sales")!;
    expect(sales.data.summary).toEqual([
      { dimension: "Customer", table: "CUSTOMER", column: "CUSTOMER_ID" },
    ]);
  });

  it("shows a view's tables when it is expanded", () => {
    const { nodes } = buildDesigner(definition(), detail(), new Set(["sales"]));
    expect(tables(nodes).map((n) => n.id).sort()).toEqual([
      "sales/CUSTOMER",
      "sales/ORDERS",
    ]);
    // ...and only that view's.
    expect(tables(nodes).every((n) => n.parentId === "sales")).toBe(true);
  });

  it("brings the view's own joins in with its tables", () => {
    // Most of why anybody expands a view is to see how it is joined.
    const collapsed = buildDesigner(definition(), detail());
    expect(kind(collapsed.edges, "internal")).toEqual([]);

    const open = buildDesigner(definition(), detail(), new Set(["sales"]));
    const internal = kind(open.edges, "internal");
    expect(internal).toHaveLength(1);
    expect(internal[0].source).toBe("sales/ORDERS");
    expect(internal[0].target).toBe("sales/CUSTOMER");
  });

  it("re-anchors the conformed edge to the real column once expanded", () => {
    // Collapsed it lands on the backdrop; expanded it lands on the card.
    // Precision, not presence.
    const open = buildDesigner(definition(), detail(), new Set(["sales"]));
    const conformed = kind(open.edges, "conformed")[0];
    expect(conformed.source).toBe("sales/CUSTOMER");
    expect(conformed.sourceHandle).toBe("source:sales::CUSTOMER.CUSTOMER_ID");
    // support is still collapsed, so its end still lands on the backdrop.
    expect(conformed.target).toBe("support");
  });

  it("marks which of a table's columns are conformed", () => {
    const { nodes } = buildDesigner(definition(), detail(), new Set(["sales"]));
    const customer = tables(nodes).find((n) => n.id === "sales/CUSTOMER")!;
    expect(customer.data.columns).toEqual([
      { name: "CUSTOMER_ID", conformed: "Customer" },
      { name: "REGION", conformed: null },
    ]);
  });

  it("keeps a table its graph declares even when no field is exposed from it", () => {
    // It can still be the table a join passes through, and a diagram
    // that hid it would show a relationship arriving from nowhere.
    const { nodes } = buildDesigner(definition(), detail(), new Set(["support"]));
    expect(tables(nodes).map((n) => n.data.table).sort()).toEqual([
      "CLIENT",
      "TICKETS",
    ]);
  });

  it("chains a three-way dimension rather than crossing every pair", () => {
    // Three crossing lines say "three mappings"; a chain says "one
    // concept, in three places".
    const three = definition({
      members: [
        ...definition().members,
        { alias: "web", database: "D", schema: "S", view: "WEB_SV" },
      ],
      sharedDimensions: [
        {
          name: "Customer",
          bindings: {
            sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
            support: { table: "CLIENT", column: "CLIENT_ID" },
            web: { table: "VISITS", column: "CUSTOMER_ID" },
          },
        },
      ],
    });
    const { edges } = buildDesigner(three, detail());
    expect(kind(edges, "conformed")).toHaveLength(2);
  });

  it("draws a suggestion dashed and separate from what is real", () => {
    const { edges } = buildDesigner(definition(), detail(), new Set(), [
      {
        name: "Month",
        reason: "Same key column in 2 views",
        bindings: {
          sales: { table: "ORDERS", column: "ORDER_MONTH" },
          support: { table: "TICKETS", column: "ORDER_MONTH" },
        },
      },
    ]);
    const ghosts = kind(edges, "ghost");
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].data?.reason).toBe("Same key column in 2 views");
    // The real one is untouched by the suggestion.
    expect(kind(edges, "conformed")).toHaveLength(1);
  });

  it("skips a binding naming a view the model no longer has", () => {
    // A definition can outlive a member if one was removed elsewhere;
    // anchoring an edge to a node that is never drawn breaks the canvas.
    const stale = definition({
      sharedDimensions: [
        {
          name: "Customer",
          bindings: {
            sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
            ghost: { table: "X", column: "Y" },
          },
        },
      ],
    });
    const { edges, nodes } = buildDesigner(stale, detail());
    expect(kind(edges, "conformed")).toEqual([]);
    expect(backdrops(nodes)).toHaveLength(2);
  });

  it("positions every backdrop somewhere, and never on top of another", () => {
    const { nodes } = buildDesigner(definition(), detail());
    const [a, b] = backdrops(nodes);
    expect(Number.isFinite(a.position.x)).toBe(true);
    expect(Number.isFinite(b.position.y)).toBe(true);
    const apart =
      Math.abs(a.position.x - b.position.x) > 0 ||
      Math.abs(a.position.y - b.position.y) > 0;
    expect(apart).toBe(true);
  });

  it("says nothing rather than throwing for a model with no members", () => {
    const empty = definition({ members: [], sharedDimensions: [] });
    const { nodes, edges } = buildDesigner(empty, detail());
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });
});

describe("parseHandle", () => {
  it("reads back exactly what columnHandle wrote", () => {
    // A drag arrives as two handle ids and nothing else; if these two
    // disagreed a drop would resolve to the WRONG column rather than
    // failing, which is the worst kind of bug this canvas could have.
    const written = columnHandle("sales", "CUSTOMER", "CUSTOMER_ID");
    expect(parseHandle(`source:${written}`)).toEqual({
      alias: "sales",
      table: "CUSTOMER",
      column: "CUSTOMER_ID",
    });
    expect(parseHandle(`target:${written}`)).toEqual({
      alias: "sales",
      table: "CUSTOMER",
      column: "CUSTOMER_ID",
    });
  });

  it("keeps a column name that contains a dot", () => {
    const written = columnHandle("sales", "ORDERS", "TOTAL.NET");
    expect(parseHandle(`source:${written}`)?.column).toBe("TOTAL.NET");
  });

  it("says nothing rather than guessing at a handle it did not write", () => {
    expect(parseHandle(null)).toBeNull();
    expect(parseHandle("")).toBeNull();
    expect(parseHandle("source:nonsense")).toBeNull();
    expect(parseHandle("source:sales::NODOT")).toBeNull();
  });
});

describe("edge styling", () => {
  it("marks each kind with a class, because React Flow does not emit data", () => {
    // The CSS was keyed on a `data-kind` attribute React Flow never
    // writes, so a view's own joins were drawn as loudly as the mappings
    // somebody made.
    const { edges } = buildDesigner(definition(), detail(), new Set(["sales"]), [
      {
        name: "Month",
        reason: "Same key column in 2 views",
        bindings: {
          sales: { table: "ORDERS", column: "ORDER_MONTH" },
          support: { table: "TICKETS", column: "ORDER_MONTH" },
        },
      },
    ]);
    const classOf = (want: string) =>
      edges.find((e) => e.data?.kind === want)?.className;
    expect(classOf("internal")).toBe("designer-edge-internal");
    expect(classOf("conformed")).toBe("designer-edge-conformed");
    expect(classOf("ghost")).toBe("designer-edge-ghost");
  });
});

describe("a member the warehouse would not describe", () => {
  it("is marked unreadable rather than rendering as an empty box", () => {
    // An empty container is indistinguishable from a broken one, and
    // that ambiguity is what made "zero tables" so hard to place.
    const blind = detail();
    blind.memberGraphs = blind.memberGraphs!.filter((g) => g.alias === "sales");
    blind.dimensions = blind.dimensions.filter((d) => d.table !== "support");
    blind.metrics = blind.metrics.filter((m) => m.table !== "support");

    const { nodes } = buildDesigner(definition(), blind);
    const backs = nodes.filter((n) => n.type === "backdrop");
    expect(backs.find((n) => n.id === "sales")!.data.readable).toBe(true);
    expect(backs.find((n) => n.id === "support")!.data.readable).toBe(false);
  });

  it("counts a member readable when it has fields but no declared joins", () => {
    // A view with one table and no relationships is perfectly normal.
    const flat = detail();
    flat.memberGraphs = flat.memberGraphs!.map((g) =>
      g.alias === "support" ? { ...g, relationships: [] } : g,
    );
    const { nodes } = buildDesigner(definition(), flat);
    const support = nodes.find((n) => n.id === "support")!;
    expect(support.data.readable).toBe(true);
  });
});
