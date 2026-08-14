import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  setOnAuthExpired: vi.fn(),
  ApiError: class extends Error {},
}));

import { apiFetch } from "../api/client";
import LoginPage from "./LoginPage";

const apiFetchMock = vi.mocked(apiFetch);

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("LoginPage", () => {
  it("shows the OAuth link in oauth mode", async () => {
    apiFetchMock.mockResolvedValueOnce({ authMode: "oauth", directLoginMethods: [] });
    renderPage();
    const link = await screen.findByRole("link", { name: /sign in with snowflake/i });
    expect(link).toHaveAttribute("href", "/auth/login");
  });

  it("submits the dev-login form in dev mode", async () => {
    apiFetchMock.mockResolvedValueOnce({
      authMode: "dev",
      directLoginMethods: ["externalbrowser", "password"],
    });
    renderPage();
    await screen.findByLabelText(/account/i);
    apiFetchMock.mockResolvedValueOnce({
      snowflakeUser: "ALICE", snowflakeAccount: "ACME", mode: "dev",
    });
    await userEvent.type(screen.getByLabelText(/account/i), "myorg-myaccount");
    await userEvent.type(screen.getByLabelText(/user/i), "alice");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenLastCalledWith("/auth/dev-login", {
        method: "POST",
        body: JSON.stringify({
          account: "myorg-myaccount",
          user: "alice",
          authenticator: "externalbrowser",
          password: null,
        }),
      }),
    );
  });

  it("submits a PEM key when the keypair method is chosen", async () => {
    apiFetchMock.mockResolvedValueOnce({
      authMode: "dev",
      directLoginMethods: ["externalbrowser", "keypair"],
    });
    renderPage();
    await screen.findByLabelText(/account/i);
    await userEvent.selectOptions(screen.getByLabelText(/authenticator/i), "keypair");
    await userEvent.type(screen.getByLabelText(/account/i), "acct");
    await userEvent.type(screen.getByLabelText(/^user/i), "alice");
    await userEvent.type(screen.getByLabelText(/private key/i), "PEMDATA");
    apiFetchMock.mockResolvedValueOnce({
      snowflakeUser: "ALICE", snowflakeAccount: "ACME", mode: "dev",
    });
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      const body = JSON.parse(apiFetchMock.mock.lastCall![1]!.body as string);
      expect(body.authenticator).toBe("keypair");
      expect(body.private_key_pem).toBe("PEMDATA");
    });
  });
});
