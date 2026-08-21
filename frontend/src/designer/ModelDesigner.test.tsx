import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompositeDefinition } from "../api/composites";
import type { CompositeViewDetail } from "../models/availability";
import ModelDesigner from "./ModelDesigner";

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

function detail(): CompositeViewDetail {
  return {
    tables: [{ name: "Customer 360" }, { name: "sales" }, { name: "support" }],
    relationships: [],
    dimensions: [
      { table: "sales", name: "CUSTOMER.CUSTOMER_ID", dataType: "TEXT" },
      { table: "sales", name: "CUSTOMER.REGION", dataType: "TEXT" },
      { table: "support", name: "CLIENT.CUSTOMER_ID", dataType: "TEXT" },
    ],
    metrics: [{ table: "sales", name: "ORDERS.REVENUE", dataType: "NUMBER" }],
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
      { alias: "support", tables: [{ name: "CLIENT" }], relationships: [] },
    ],
  };
}

function renderDesigner(over: Partial<CompositeDefinition> = {}) {
  const onChange = vi.fn();
  render(
    <ModelDesigner
      modelId="m1"
      definition={definition(over)}
      detail={detail()}
      onChange={onChange}
    />,
  );
  return { onChange };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("ModelDesigner", () => {
  it("draws a backdrop per view, collapsed", async () => {
    renderDesigner();
    expect(
      await screen.findByRole("button", { name: /expand sales/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expand support/i })).toBeInTheDocument();
  });

  it("shows the view's tables when its header is clicked", async () => {
    // This shipped once with a toggle that did nothing: React Flow claims
    // the pointer for a node drag unless the control says `nodrag`, so
    // the click never landed and every container stayed empty.
    renderDesigner();
    await userEvent.click(await screen.findByRole("button", { name: /expand sales/i }));

    expect(await screen.findByText("ORDERS")).toBeInTheDocument();
    expect(screen.getByText("CUSTOMER")).toBeInTheDocument();
    // ...and the header now offers the opposite.
    expect(screen.getByRole("button", { name: /collapse sales/i })).toBeInTheDocument();
  });

  it("shows only the expanded view's tables", async () => {
    renderDesigner();
    await userEvent.click(await screen.findByRole("button", { name: /expand sales/i }));
    await screen.findByText("ORDERS");
    expect(screen.queryByText("CLIENT")).toBeNull();
  });

  it("lists a view's columns once expanded", async () => {
    renderDesigner();
    await userEvent.click(await screen.findByRole("button", { name: /expand sales/i }));
    expect(await screen.findByText("REVENUE")).toBeInTheDocument();
    expect(screen.getByText("REGION")).toBeInTheDocument();
  });

  it("remembers which views were open", async () => {
    const { unmount } = render(
      <ModelDesigner
        modelId="m1"
        definition={definition()}
        detail={detail()}
        onChange={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /expand sales/i }));
    await screen.findByText("ORDERS");
    unmount();

    render(
      <ModelDesigner
        modelId="m1"
        definition={definition()}
        detail={detail()}
        onChange={vi.fn()}
      />,
    );
    expect(await screen.findByText("ORDERS")).toBeInTheDocument();
  });

  it("expands and collapses every view at once", async () => {
    renderDesigner();
    await userEvent.click(await screen.findByRole("button", { name: /expand all/i }));
    expect(await screen.findByText("ORDERS")).toBeInTheDocument();
    expect(screen.getByText("CLIENT")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /collapse all/i }));
    await waitFor(() => expect(screen.queryByText("ORDERS")).toBeNull());
  });

  it("offers the matching columns it found, and does not apply them", async () => {
    // Both views name a CUSTOMER_ID. A mapping the app made is one
    // nobody reviewed, so it is offered and nothing more.
    const { onChange } = renderDesigner();
    expect(
      await screen.findByRole("button", { name: /accept 1 suggested/i }),
    ).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("accepting a suggestion produces the mapping", async () => {
    const { onChange } = renderDesigner();
    await userEvent.click(
      await screen.findByRole("button", { name: /accept 1 suggested/i }),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const next = onChange.mock.calls[0][0] as CompositeDefinition;
    expect(next.sharedDimensions).toEqual([
      {
        name: "Customer",
        bindings: {
          sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
          support: { table: "CLIENT", column: "CUSTOMER_ID" },
        },
      },
    ]);
  });

  it("stops suggesting what is already mapped", async () => {
    renderDesigner({
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
    await screen.findByRole("button", { name: /expand sales/i });
    expect(screen.queryByRole("button", { name: /suggested/i })).toBeNull();
  });

  it("offers the first view on the canvas, rather than sending anybody to a form", async () => {
    // A designer that cannot start a model is a viewer.
    render(
      <ModelDesigner
        modelId="m1"
        definition={definition({ members: [], sharedDimensions: [] })}
        detail={detail()}
        views={[{ database: "A", schema: "P", name: "SALES_SV", comment: null }]}
        onChange={vi.fn()}
      />,
    );
    expect(await screen.findByText(/add a view to start/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Add a view")).toHaveTextContent("A.P.SALES_SV");
  });

  it("adds a view to the model from the canvas", async () => {
    const onChange = vi.fn();
    render(
      <ModelDesigner
        modelId="m1"
        definition={definition({ members: [], sharedDimensions: [] })}
        detail={detail()}
        views={[{ database: "A", schema: "P", name: "SALES_SV", comment: null }]}
        onChange={onChange}
      />,
    );
    await userEvent.selectOptions(
      await screen.findByLabelText("Add a view"),
      "A.P.SALES_SV",
    );
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const next = onChange.mock.calls[0][0] as CompositeDefinition;
    expect(next.members).toEqual([
      { alias: "sales", database: "A", schema: "P", view: "SALES_SV" },
    ]);
  });

  it("does not offer a view the model already has", async () => {
    render(
      <ModelDesigner
        modelId="m1"
        definition={definition()}
        detail={detail()}
        views={[
          { database: "D", schema: "S", name: "SALES_SV", comment: null },
          { database: "D", schema: "S", name: "BILLING_SV", comment: null },
        ]}
        onChange={vi.fn()}
      />,
    );
    const picker = await screen.findByLabelText("Add a view");
    expect(picker).not.toHaveTextContent("SALES_SV");
    expect(picker).toHaveTextContent("BILLING_SV");
  });

  it("removes a view, and the mappings that named it", async () => {
    const onChange = vi.fn();
    render(
      <ModelDesigner
        modelId="m1"
        definition={definition({
          sharedDimensions: [
            {
              name: "Customer",
              bindings: {
                sales: { table: "CUSTOMER", column: "CUSTOMER_ID" },
                support: { table: "CLIENT", column: "CUSTOMER_ID" },
              },
            },
          ],
        })}
        detail={detail()}
        onChange={onChange}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /remove support from this model/i }),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const next = onChange.mock.calls[0][0] as CompositeDefinition;
    expect(next.members.map((m) => m.alias)).toEqual(["sales"]);
    // One binding is not a shared dimension, so it goes with the view.
    expect(next.sharedDimensions).toEqual([]);
  });

  it("offers nothing to edit when the workspace is read-only", async () => {
    render(
      <ModelDesigner
        modelId="m1"
        definition={definition()}
        detail={detail()}
        readOnly
        onChange={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: /expand sales/i });
    expect(screen.queryByRole("button", { name: /suggested/i })).toBeNull();
  });
});

describe("full screen", () => {
  it("fills the window and offers the way back", async () => {
    renderDesigner();
    const button = await screen.findByRole("button", { name: /full screen/i });
    expect(button).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(button);
    expect(document.querySelector(".designer-canvas")).toHaveClass("is-maximised");
    expect(
      screen.getByRole("button", { name: /exit full screen/i }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("leaves on Escape, because a full-window canvas needs a way out", async () => {
    renderDesigner();
    await userEvent.click(await screen.findByRole("button", { name: /full screen/i }));
    expect(document.querySelector(".designer-canvas")).toHaveClass("is-maximised");

    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(document.querySelector(".designer-canvas")).not.toHaveClass(
        "is-maximised",
      ),
    );
  });

  it("does not listen for Escape when it is not full screen", async () => {
    // Otherwise the designer would swallow Escape from anything else on
    // the page that wanted it.
    renderDesigner();
    await screen.findByRole("button", { name: /full screen/i });
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector(".designer-canvas")).not.toHaveClass(
      "is-maximised",
    );
  });
});
