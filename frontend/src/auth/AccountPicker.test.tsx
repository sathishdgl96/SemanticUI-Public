import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccountPicker } from "./AccountPicker";

const ACCOUNTS = [
  { label: "Production", account: "myorg-prod" },
  { label: "Sandbox", account: "myorg-dev" },
];

describe("AccountPicker", () => {
  it("lists every configured account by its label", () => {
    render(
      <AccountPicker accounts={ACCOUNTS} value="myorg-prod" onChange={() => {}} />,
    );
    expect(screen.getByRole("option", { name: "Production" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Sandbox" })).toBeInTheDocument();
  });

  it("reports the chosen account", async () => {
    const onChange = vi.fn();
    render(
      <AccountPicker accounts={ACCOUNTS} value="myorg-prod" onChange={onChange} />,
    );
    await userEvent.selectOptions(screen.getByLabelText(/account/i), "myorg-dev");
    expect(onChange).toHaveBeenCalledWith("myorg-dev");
  });

  it("stays out of the way when there is only one account", () => {
    // A dropdown with one entry is a decision the user does not have.
    const { container } = render(
      <AccountPicker
        accounts={[ACCOUNTS[0]]}
        value="myorg-prod"
        onChange={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing rather than an empty control when unconfigured", () => {
    const { container } = render(
      <AccountPicker accounts={[]} value="" onChange={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
