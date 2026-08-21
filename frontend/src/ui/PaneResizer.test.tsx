import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import PaneResizer from "./PaneResizer";
import { MAX_PANE, MIN_PANE, useResizablePane } from "./useResizablePane";

function Harness({ initial = 260 }: { initial?: number }) {
  const pane = useResizablePane("test.pane.width", initial);
  return (
    <div style={{ width: pane.width }} data-testid="pane">
      <span>width: {pane.width}</span>
      <PaneResizer
        label="Resize the field list"
        width={pane.width}
        onBegin={pane.beginResize}
        onNudge={pane.nudge}
        onReset={pane.reset}
      />
    </div>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("PaneResizer", () => {
  it("is announced as something adjustable, not a decorative sliver", async () => {
    render(<Harness />);
    const handle = screen.getByRole("separator", { name: /resize the field list/i });
    expect(handle).toHaveAttribute("aria-valuenow", "260");
    expect(handle).toHaveAttribute("aria-valuemin", String(MIN_PANE));
    expect(handle).toHaveAttribute("aria-valuemax", String(MAX_PANE));
  });

  it("widens with the arrow keys, because a pointer drag is not available to everybody", async () => {
    render(<Harness />);
    const handle = screen.getByRole("separator");
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByText("width: 276")).toBeInTheDocument();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByText("width: 244")).toBeInTheDocument();
  });

  it("will not be nudged narrower than a field name can live in", async () => {
    render(<Harness initial={MIN_PANE} />);
    screen.getByRole("separator").focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(screen.getByText(`width: ${MIN_PANE}`)).toBeInTheDocument();
  });

  it("will not be nudged past the point where it is the whole screen", async () => {
    render(<Harness initial={MAX_PANE} />);
    screen.getByRole("separator").focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByText(`width: ${MAX_PANE}`)).toBeInTheDocument();
  });

  it("goes back to the default on Home, and on a double-click", async () => {
    render(<Harness />);
    const handle = screen.getByRole("separator");
    handle.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByText("width: 292")).toBeInTheDocument();

    await userEvent.keyboard("{Home}");
    expect(screen.getByText("width: 260")).toBeInTheDocument();

    await userEvent.keyboard("{ArrowRight}");
    await userEvent.dblClick(handle);
    expect(screen.getByText("width: 260")).toBeInTheDocument();
  });

  it("remembers the width, because setting it every visit is not a feature", async () => {
    const { unmount } = render(<Harness />);
    screen.getByRole("separator").focus();
    await userEvent.keyboard("{ArrowRight}");
    unmount();

    render(<Harness />);
    expect(screen.getByText("width: 276")).toBeInTheDocument();
  });

  it("ignores a stored value that is not a width", async () => {
    // It survives releases and is editable by hand; NaN reaching a style
    // attribute would collapse the pane with no way back.
    window.localStorage.setItem("test.pane.width", "not-a-number");
    render(<Harness />);
    expect(screen.getByText("width: 260")).toBeInTheDocument();
  });

  it("clamps a stored value that is out of range", async () => {
    window.localStorage.setItem("test.pane.width", "9999");
    render(<Harness />);
    expect(screen.getByText(`width: ${MAX_PANE}`)).toBeInTheDocument();
  });
});
