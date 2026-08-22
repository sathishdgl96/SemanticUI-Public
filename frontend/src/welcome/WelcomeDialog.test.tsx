import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Welcome } from "../api/home";
import WelcomeDialog from "./WelcomeDialog";

function show(welcome: Partial<Welcome> = {}, onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <WelcomeDialog
        name="SemanticUI"
        welcome={{ path: "explore", canAuthor: true, seen: false, ...welcome }}
        onClose={onClose}
      />
    </MemoryRouter>,
  );
  return onClose;
}

describe("WelcomeDialog", () => {
  it("explains the arc, which no empty state does", () => {
    show();

    // The specific claim: a newcomer should leave knowing the shape of the
    // product, not just their next click.
    expect(screen.getByRole("dialog")).toHaveTextContent(/explore/i);
    expect(screen.getByRole("dialog")).toHaveTextContent(/report/i);
    expect(screen.getByRole("dialog")).toHaveTextContent(/Excel/i);
  });

  it("starts somebody with nothing at a model", () => {
    show({ path: "explore" });

    expect(screen.getByRole("link", { name: /explore a model/i })).toHaveAttribute(
      "href",
      "/explore",
    );
  });

  it("starts somebody dropped into a populated workspace at their team's work", () => {
    show({ path: "team" });

    expect(
      screen.getByRole("link", { name: /open what your team/i }),
    ).toHaveAttribute("href", "/reports");
  });

  it("does not tell a viewer to build a report", () => {
    // Advice you cannot act on teaches people to stop reading.
    show({ path: "team", canAuthor: false });

    expect(screen.queryByText(/build your own/i)).not.toBeInTheDocument();
  });

  it("tells an editor how to build one", () => {
    show({ path: "team", canAuthor: true });

    expect(screen.getByText(/build your own/i)).toBeInTheDocument();
  });

  it("closes when dismissed", async () => {
    const onClose = show();

    await userEvent.click(screen.getByRole("button", { name: /get started/i }));

    expect(onClose).toHaveBeenCalled();
  });
});
