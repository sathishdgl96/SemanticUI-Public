import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FacetChips } from "./FacetChips";

const ROLE_FACET = [{ key: "role", label: "Role: ANALYST" }];

describe("FacetChips", () => {
  it("says why the list is shorter than the whole", () => {
    render(<FacetChips facets={ROLE_FACET} onClear={() => {}} shown={12} total={137} />);
    expect(screen.getByText(/showing 12 of 137/i)).toBeInTheDocument();
  });

  it("clears a facet when its chip is dismissed", async () => {
    const onClear = vi.fn();
    render(<FacetChips facets={ROLE_FACET} onClear={onClear} shown={12} total={137} />);
    await userEvent.click(screen.getByRole("button", { name: /clear role/i }));
    expect(onClear).toHaveBeenCalledWith("role");
  });

  it("stays out of the way when nothing is filtered", () => {
    const { container } = render(
      <FacetChips facets={[]} onClear={() => {}} shown={137} total={137} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("offers every active facet separately", async () => {
    const onClear = vi.fn();
    render(
      <FacetChips
        facets={[
          { key: "role", label: "Role: ANALYST" },
          { key: "favorite", label: "Pinned only" },
        ]}
        onClear={onClear}
        shown={3}
        total={137}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /clear favorite/i }));
    expect(onClear).toHaveBeenCalledWith("favorite");
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
