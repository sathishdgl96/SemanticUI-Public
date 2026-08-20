import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ContextMenu, { useContextMenu } from "./ContextMenu";

function Harness({ onPick }: { onPick: () => void }) {
  const menu = useContextMenu();
  return (
    <div>
      <div data-testid="surface" onContextMenu={menu.open}>
        right-click me
      </div>
      <p data-testid="outside">elsewhere</p>
      {menu.at && (
        <ContextMenu
          at={menu.at}
          items={[
            { id: "pick", label: "Pin to dashboard", icon: "pin", onSelect: onPick },
            {
              id: "blocked",
              label: "Delete visual",
              danger: true,
              separatorBefore: true,
              disabledReason: "You cannot edit this report.",
              onSelect: () => {},
            },
          ]}
          onClose={menu.close}
        />
      )}
    </div>
  );
}

async function openMenu() {
  await userEvent.pointer({
    keys: "[MouseRight]",
    target: screen.getByTestId("surface"),
  });
}

describe("ContextMenu", () => {
  it("replaces the browser's menu on the surface it covers", async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    screen.getByTestId("surface").dispatchEvent(event);
    // Suppressing the browser menu and offering a replacement are the same
    // act: one must not happen without the other.
    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  it("leaves the browser's own menu alone everywhere else", () => {
    render(<Harness onPick={vi.fn()} />);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    screen.getByTestId("outside").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("runs the chosen action and closes", async () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    await openMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /pin to dashboard/i }));
    expect(onPick).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("greys an unavailable action and says why, rather than hiding it", async () => {
    // An action that is missing reads as a bug; one that says why does not.
    render(<Harness onPick={vi.fn()} />);
    await openMenu();
    const blocked = screen.getByRole("menuitem", { name: /delete visual/i });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute("title", "You cannot edit this report.");
  });

  it("closes on Escape", async () => {
    render(<Harness onPick={vi.fn()} />);
    await openMenu();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on a click anywhere else", async () => {
    render(<Harness onPick={vi.fn()} />);
    await openMenu();
    await userEvent.click(screen.getByTestId("outside"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("focuses its first item, so it is operable from the keyboard", async () => {
    // Shift+F10 and the Menu key raise a contextmenu event exactly as the
    // right button does, and land here.
    render(<Harness onPick={vi.fn()} />);
    await openMenu();
    expect(screen.getByRole("menuitem", { name: /pin to dashboard/i })).toHaveFocus();
  });
});
