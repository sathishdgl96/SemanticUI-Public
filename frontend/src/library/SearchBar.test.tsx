import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchBar } from "./SearchBar";

describe("SearchBar", () => {
  it("reports what was typed", async () => {
    const onChange = vi.fn();
    render(<SearchBar value="" onChange={onChange} />);
    await userEvent.type(screen.getByRole("searchbox"), "ch");
    expect(onChange).toHaveBeenCalled();
  });

  it("offers a way to clear once there is something to clear", async () => {
    const onChange = vi.fn();
    render(<SearchBar value="churn" onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /clear search/i }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("shows no clear button while the field is empty", () => {
    render(<SearchBar value="" onChange={() => {}} />);
    expect(screen.queryByRole("button", { name: /clear search/i })).toBeNull();
  });
});
