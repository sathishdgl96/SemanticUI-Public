import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Page } from "../api/types";
import PageBar from "./PageBar";

const pages: Page[] = [
  { id: "p1", name: "Overview", visuals: [], filters: [] },
  { id: "p2", name: "Detail", visuals: [], filters: [] },
];

const props = {
  pages,
  activeId: "p1",
  canEdit: true,
  onSelect: () => {},
  onAdd: () => {},
  onAddSheet: () => {},
  onRename: () => {},
  onDuplicate: () => {},
  onDelete: () => {},
  onMove: () => {},
};

const openMenu = () =>
  userEvent.click(screen.getByRole("button", { name: /page actions/i }));

describe("PageBar", () => {
  it("marks the active tab and switches on click", async () => {
    const onSelect = vi.fn();
    render(<PageBar {...props} onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await userEvent.click(screen.getByRole("button", { name: "Detail" }));
    expect(onSelect).toHaveBeenCalledWith("p2");
  });

  it("adds a sheet, and shows sheet tabs with the grid mark", async () => {
    const onAddSheet = vi.fn();
    const withSheet: Page[] = [
      ...pages,
      { id: "p3", name: "Sheet 1", kind: "sheet", visuals: [], filters: [] },
    ];
    render(<PageBar {...props} pages={withSheet} onAddSheet={onAddSheet} />);
    // The sheet tab is visibly a sheet, not just another page.
    expect(screen.getByRole("button", { name: /Sheet 1/ }).textContent).toContain("⊞");
    await userEvent.click(screen.getByRole("button", { name: "New sheet" }));
    expect(onAddSheet).toHaveBeenCalled();
  });

  it("adds a page", async () => {
    const onAdd = vi.fn();
    render(<PageBar {...props} onAdd={onAdd} />);
    await userEvent.click(screen.getByRole("button", { name: /new page/i }));
    expect(onAdd).toHaveBeenCalled();
  });

  it("renames through the menu, committing on Enter", async () => {
    const onRename = vi.fn();
    render(<PageBar {...props} onRename={onRename} />);
    await openMenu();
    await userEvent.click(screen.getByRole("button", { name: /rename/i }));
    const input = screen.getByLabelText(/page name/i);
    await userEvent.clear(input);
    await userEvent.type(input, "Summary{Enter}");
    expect(onRename).toHaveBeenCalledWith("p1", "Summary");
  });

  it("refuses a rename that collides with another page", async () => {
    const onRename = vi.fn();
    render(<PageBar {...props} onRename={onRename} />);
    await openMenu();
    await userEvent.click(screen.getByRole("button", { name: /rename/i }));
    const input = screen.getByLabelText(/page name/i);
    await userEvent.clear(input);
    await userEvent.type(input, "Detail{Enter}");
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/already exists/i);
  });

  it("cancels a rename on Escape", async () => {
    const onRename = vi.fn();
    render(<PageBar {...props} onRename={onRename} />);
    await openMenu();
    await userEvent.click(screen.getByRole("button", { name: /rename/i }));
    await userEvent.type(screen.getByLabelText(/page name/i), "{Escape}");
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/page name/i)).toBeNull();
  });

  it("starts a rename on double-clicking the active tab", async () => {
    render(<PageBar {...props} />);
    await userEvent.dblClick(screen.getByRole("button", { name: "Overview" }));
    expect(screen.getByLabelText(/page name/i)).toHaveValue("Overview");
  });

  it("duplicates through the menu", async () => {
    const onDuplicate = vi.fn();
    render(<PageBar {...props} onDuplicate={onDuplicate} />);
    await openMenu();
    await userEvent.click(screen.getByRole("button", { name: /duplicate/i }));
    expect(onDuplicate).toHaveBeenCalledWith("p1");
  });

  it("moves right but not past the left end", async () => {
    const onMove = vi.fn();
    render(<PageBar {...props} onMove={onMove} />);
    await openMenu();
    expect(screen.getByRole("button", { name: /move left/i })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /move right/i }));
    expect(onMove).toHaveBeenCalledWith("p1", 1);
  });

  it("deletes only after a confirm", async () => {
    const onDelete = vi.fn();
    render(<PageBar {...props} onDelete={onDelete} />);
    await openMenu();
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(onDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /delete page/i }));
    expect(onDelete).toHaveBeenCalledWith("p1");
  });

  it("never offers to delete the last page", async () => {
    render(<PageBar {...props} pages={[pages[0]]} />);
    await openMenu();
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeDisabled();
  });

  it("shows a viewer plain tabs: switching only", () => {
    render(<PageBar {...props} canEdit={false} />);
    expect(screen.queryByRole("button", { name: /new page/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /page actions/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Detail" })).toBeInTheDocument();
  });
});
