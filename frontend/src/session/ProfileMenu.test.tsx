import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileMenu } from "./ProfileMenu";

const getSessionContext = vi.fn();
const setSessionContext = vi.fn();

vi.mock("../api/session", () => ({
  getSessionContext: (...args: unknown[]) => getSessionContext(...args),
  setSessionContext: (...args: unknown[]) => setSessionContext(...args),
}));

function renderMenu() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProfileMenu user="ALICE" account="ACME" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getSessionContext.mockReset();
  setSessionContext.mockReset();
  getSessionContext.mockResolvedValue({
    role: "ANALYST",
    warehouse: "COMPUTE_WH",
    roles: ["ANALYST", "FINANCE"],
    warehouses: ["COMPUTE_WH", "BIG_WH"],
  });
  setSessionContext.mockResolvedValue({
    role: "FINANCE",
    warehouse: "COMPUTE_WH",
  });
});

describe("ProfileMenu", () => {
  it("shows who you are and what you are running as, without opening", async () => {
    renderMenu();
    expect(await screen.findByText(/ALICE/)).toBeInTheDocument();
    expect(await screen.findByText(/ANALYST/)).toBeInTheDocument();
    expect(await screen.findByText(/COMPUTE_WH/)).toBeInTheDocument();
  });

  it("keeps the menu closed until asked", async () => {
    renderMenu();
    await screen.findByText(/ANALYST/);
    expect(screen.queryByLabelText(/^role$/i)).not.toBeInTheDocument();
  });

  it("switches role from the menu", async () => {
    renderMenu();
    await userEvent.click(
      await screen.findByRole("button", { name: /account menu/i }),
    );
    await userEvent.selectOptions(await screen.findByLabelText(/^role$/i), "FINANCE");
    await waitFor(() =>
      expect(setSessionContext).toHaveBeenCalledWith({ role: "FINANCE" }),
    );
  });

  it("switches warehouse without disturbing the role", async () => {
    renderMenu();
    await userEvent.click(
      await screen.findByRole("button", { name: /account menu/i }),
    );
    await userEvent.selectOptions(
      await screen.findByLabelText(/^warehouse$/i),
      "BIG_WH",
    );
    await waitFor(() =>
      expect(setSessionContext).toHaveBeenCalledWith({ warehouse: "BIG_WH" }),
    );
  });

  it("still names the user when the context cannot be read", async () => {
    // Snowflake being unreachable must not blank out the identity in
    // the top bar -- the user still needs to know who they are and how
    // to log out.
    getSessionContext.mockRejectedValue(new Error("nope"));
    renderMenu();
    expect(await screen.findByText(/ALICE/)).toBeInTheDocument();
  });
});
