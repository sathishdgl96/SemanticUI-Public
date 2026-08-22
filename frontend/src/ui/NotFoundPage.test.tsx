import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import NotFoundPage from "./NotFoundPage";

function wrap() {
  return render(
    <MemoryRouter>
      <NotFoundPage />
    </MemoryRouter>,
  );
}

describe("NotFoundPage", () => {
  it("says plainly that the page is missing, rather than leaving a blank screen", () => {
    wrap();
    expect(screen.getByRole("heading", { name: "404" })).toBeInTheDocument();
    expect(screen.getByText(/doesn't exist/i)).toBeInTheDocument();
  });

  it("offers a way home, because a dead link with no exit is a trap", () => {
    wrap();
    expect(screen.getByRole("link", { name: /home/i })).toHaveAttribute("href", "/");
  });
});
