import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import Pane from "./Pane";
import { useResizablePane } from "../ui/useResizablePane";

function Harness() {
  const size = useResizablePane("test.data.width", 232, "left");
  return (
    <Pane title="Data" resize={size}>
      <p>rows</p>
    </Pane>
  );
}

beforeEach(() => window.localStorage.clear());

describe("Pane", () => {
  it("has no handle unless it was given something to resize", () => {
    render(<Pane title="Filters"><p>none</p></Pane>);
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("wears the width it was given and offers a handle named after itself", async () => {
    render(<Harness />);
    const pane = screen.getByRole("region", { name: "Data" });
    expect(pane).toHaveStyle({ width: "232px", flexBasis: "232px" });
    const handle = screen.getByRole("separator", { name: /resize data/i });
    handle.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(pane).toHaveStyle({ width: "248px", flexBasis: "248px" });
  });

  it("drops the width with the pane when it collapses to a strip", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /collapse data/i }));
    const strip = screen.getByRole("button", { name: /expand data/i });
    expect(strip).not.toHaveAttribute("style");
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });
});
