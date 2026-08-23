import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ColorField, { isHex } from "./ColorField";

function renderField(value = "") {
  const onChange = vi.fn();
  render(
    <ColorField label="Background" value={value} fallback="#ffffff" onChange={onChange} />,
  );
  return onChange;
}

describe("ColorField", () => {
  it("accepts a typed hex value", async () => {
    const onChange = renderField();
    await userEvent.type(screen.getByLabelText("Background"), "#0b0b0b");
    expect(onChange).toHaveBeenLastCalledWith("#0b0b0b");
  });

  it("does not emit a half-typed value", async () => {
    // "#0b0" is a valid three-digit hex on the way to "#0b0b0b", so the box
    // keeps every keystroke while the document only sees complete ones.
    const onChange = renderField();
    await userEvent.type(screen.getByLabelText("Background"), "#0b");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Background")).toHaveValue("#0b");
  });

  it("marks an unparseable value rather than silently ignoring it", async () => {
    const onChange = renderField();
    await userEvent.type(screen.getByLabelText("Background"), "corporate blue");
    expect(screen.getByLabelText("Background")).toHaveAttribute("aria-invalid", "true");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("resets to absent rather than to a colour", async () => {
    // Absent means "whatever the product's own palette says", which is not
    // the same as any particular hex.
    const onChange = renderField("#123456");
    await userEvent.click(screen.getByRole("button", { name: /reset background/i }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("offers no reset when nothing is set", () => {
    renderField();
    expect(screen.queryByRole("button", { name: /reset/i })).toBeNull();
  });

  it("shows the fallback in the swatch until a colour is chosen", () => {
    renderField();
    expect(screen.getByLabelText("Background swatch")).toHaveValue("#ffffff");
  });
});

describe("isHex", () => {
  it("takes three and six digit forms, and nothing else", () => {
    expect(isHex("#abc")).toBe(true);
    expect(isHex("#AABBCC")).toBe(true);
    expect(isHex("abc")).toBe(false);
    expect(isHex("#abcd")).toBe(false);
    // The reason the check exists: these reach a `style` attribute.
    expect(isHex("red; background: url(http://x)")).toBe(false);
  });
});
