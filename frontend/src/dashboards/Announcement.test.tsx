import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Announcement, { ANNOUNCEMENT_MAX } from "./Announcement";

describe("Announcement", () => {
  it("shows the note to everyone who opens the dashboard", () => {
    render(
      <Announcement text="Q3 is provisional until the 5th." canEdit={false} onChange={vi.fn()} />,
    );
    expect(screen.getByRole("note", { name: /announcement/i })).toHaveTextContent(
      "Q3 is provisional until the 5th.",
    );
  });

  it("cannot be dismissed", () => {
    // A caveat you can turn off is a caveat half the readers will not
    // have. A reader gets no control over it at all.
    render(<Announcement text="Provisional." canEdit={false} onChange={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is nothing at all when there is none and you cannot write one", () => {
    const { container } = render(
      <Announcement text={null} canEdit={false} onChange={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("offers an editor a first one without leaving a banner-shaped hole", async () => {
    const onChange = vi.fn();
    render(<Announcement text={null} canEdit onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /add an announcement/i }));
    await userEvent.type(screen.getByLabelText("Announcement"), "Refreshed at 6am.");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onChange).toHaveBeenCalledWith("Refreshed at 6am.");
  });

  it("edits an existing one, starting from what it says", async () => {
    const onChange = vi.fn();
    render(<Announcement text="Old note." canEdit onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /edit/i }));
    const box = screen.getByLabelText("Announcement");
    expect(box).toHaveValue("Old note.");
    await userEvent.clear(box);
    await userEvent.type(box, "New note.");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onChange).toHaveBeenCalledWith("New note.");
  });

  it("clears it with the x, and reports null rather than an empty string", async () => {
    const onChange = vi.fn();
    render(<Announcement text="Old note." canEdit onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /remove announcement/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("treats whitespace as no announcement", async () => {
    const onChange = vi.fn();
    render(<Announcement text={null} canEdit onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /add an announcement/i }));
    await userEvent.type(screen.getByLabelText("Announcement"), "   ");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("backs out without changing anything", async () => {
    const onChange = vi.fn();
    render(<Announcement text="Old note." canEdit onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /edit/i }));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("note", { name: /announcement/i })).toBeInTheDocument();
  });

  it("stops at the length the server stops at", async () => {
    render(<Announcement text={null} canEdit onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /add an announcement/i }));
    expect(screen.getByLabelText("Announcement")).toHaveAttribute(
      "maxlength",
      String(ANNOUNCEMENT_MAX),
    );
  });
});
