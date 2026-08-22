import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LoadingScreen from "./LoadingScreen";

describe("LoadingScreen", () => {
  it("announces itself as a status, because a silent spinner tells a screen-reader user nothing", () => {
    render(<LoadingScreen />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/loading/i);
  });

  it("carries the product name, so the wait is branded rather than anonymous", () => {
    render(<LoadingScreen />);
    expect(screen.getByText("SemanticUI")).toBeInTheDocument();
  });

  it("takes a deployment's own name, so a white-labelled install does not wait under ours", () => {
    render(<LoadingScreen name="Acme Analytics" />);
    expect(screen.getByText("Acme Analytics")).toBeInTheDocument();
    expect(screen.queryByText("SemanticUI")).not.toBeInTheDocument();
  });

  it("takes a caller's own wording, so a slow route can say what it is fetching", () => {
    render(<LoadingScreen label="Opening report…" />);
    expect(screen.getByRole("status")).toHaveTextContent("Opening report…");
  });
});
