import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FieldInfo, Hierarchy } from "../api/types";
import HierarchyPane from "./HierarchyPane";

const DIMENSIONS: FieldInfo[] = [
  { table: "CUSTOMERS", name: "COUNTRY", dataType: "VARCHAR" },
  { table: "CUSTOMERS", name: "STATE", dataType: "VARCHAR" },
  { table: "CUSTOMERS", name: "CITY", dataType: "VARCHAR" },
];

const GEO: Hierarchy = {
  id: "h1",
  name: "Geography",
  levels: ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE"],
};

describe("HierarchyPane", () => {
  it("says there are none yet", () => {
    render(<HierarchyPane hierarchies={[]} dimensions={DIMENSIONS} onChange={() => {}} />);
    expect(screen.getByText(/no hierarchies yet/i)).toBeInTheDocument();
  });

  it("creates one", async () => {
    const onChange = vi.fn();
    render(
      <HierarchyPane hierarchies={[]} dimensions={DIMENSIONS} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /new hierarchy/i }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ name: "New hierarchy", levels: [] }),
    ]);
  });

  it("appends a level", async () => {
    const onChange = vi.fn();
    render(
      <HierarchyPane hierarchies={[GEO]} dimensions={DIMENSIONS} onChange={onChange} />,
    );
    await userEvent.selectOptions(
      screen.getByLabelText(/add a level to Geography/i),
      "CUSTOMERS.CITY",
    );
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        levels: ["CUSTOMERS.COUNTRY", "CUSTOMERS.STATE", "CUSTOMERS.CITY"],
      }),
    ]);
  });

  it("does not offer a dimension the hierarchy already uses", () => {
    render(
      <HierarchyPane hierarchies={[GEO]} dimensions={DIMENSIONS} onChange={() => {}} />,
    );
    const select = screen.getByLabelText(
      /add a level to Geography/i,
    ) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).not.toContain("CUSTOMERS.COUNTRY");
  });

  it("warns while a hierarchy has fewer than two levels", () => {
    render(
      <HierarchyPane
        hierarchies={[{ id: "h1", name: "Geo", levels: ["CUSTOMERS.COUNTRY"] }]}
        dimensions={DIMENSIONS}
        onChange={() => {}}
      />,
    );
    // Saving this would fail server-side; saying so here beats a 400 later.
    expect(screen.getByText(/needs at least two levels/i)).toBeInTheDocument();
  });

  it("does not warn once it has two", () => {
    render(
      <HierarchyPane hierarchies={[GEO]} dimensions={DIMENSIONS} onChange={() => {}} />,
    );
    expect(screen.queryByText(/needs at least two levels/i)).toBeNull();
  });

  it("removes a level", async () => {
    const onChange = vi.fn();
    render(
      <HierarchyPane hierarchies={[GEO]} dimensions={DIMENSIONS} onChange={onChange} />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /remove CUSTOMERS.STATE/i }),
    );
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ levels: ["CUSTOMERS.COUNTRY"] }),
    ]);
  });

  it("deletes a whole hierarchy", async () => {
    const onChange = vi.fn();
    render(
      <HierarchyPane hierarchies={[GEO]} dimensions={DIMENSIONS} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /delete Geography/i }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("renames one", async () => {
    const onChange = vi.fn();
    render(
      <HierarchyPane hierarchies={[GEO]} dimensions={DIMENSIONS} onChange={onChange} />,
    );
    await userEvent.type(screen.getByLabelText(/hierarchy name for Geography/i), "!");
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ name: "Geography!" }),
    ]);
  });

  it("does not offer to edit a model-declared hierarchy", () => {
    // Model hierarchies come from the semantic view, not the report, so there
    // is nothing here that could change them.
    render(
      <HierarchyPane
        hierarchies={[{ id: "model:C.GEO", name: "Model geo", levels: ["A.B", "A.C"] }]}
        dimensions={DIMENSIONS}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /delete Model geo/i })).toBeNull();
    expect(screen.getByText(/defined by the semantic model/i)).toBeInTheDocument();
  });
});
