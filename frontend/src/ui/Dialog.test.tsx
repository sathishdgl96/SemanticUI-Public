import { useRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Dialog from "./Dialog";

/** A dialog opened from a button, which is the only way one ever opens --
 *  and the only way to test that focus goes back where it came from. */
function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button">Elsewhere</button>
      {open && (
        <Dialog
          title="Getting started"
          returnFocusTo={trigger}
          onClose={() => {
            setOpen(false);
            onClose();
          }}
        >
          <button type="button">Inside first</button>
          <button type="button">Inside last</button>
        </Dialog>
      )}
    </>
  );
}

describe("Dialog", () => {
  it("is a modal dialog labelled by its own heading", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Getting started");
  });

  it("moves focus into itself on open", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("returns focus to whatever opened it", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    await userEvent.click(trigger);

    await userEvent.keyboard("{Escape}");

    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
  });

  it("keeps Tab inside itself", async () => {
    // The one component that can strand a keyboard user with no way out, so
    // the cycle is tested rather than assumed.
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    const last = screen.getByRole("button", { name: "Inside last" });
    last.focus();
    await userEvent.tab();

    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: "Elsewhere" }),
    );
  });

  it("cycles backwards too", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    screen.getByRole("button", { name: "Inside first" }).focus();
    await userEvent.tab({ shift: true });

    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });
});
