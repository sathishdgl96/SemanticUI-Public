import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  setOnAuthExpired: vi.fn(),
  ApiError: class extends Error {
    code: string;
    status: number;
    detail?: string | null;
    constructor(code: string, status: number, message: string, detail?: string | null) {
      super(message);
      this.code = code;
      this.status = status;
      this.detail = detail;
    }
  },
}));

import { apiFetch, ApiError } from "../api/client";
import LoginPage from "./LoginPage";

const apiFetchMock = vi.mocked(apiFetch);

function renderPage(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return {
    qc,
    // Mirrors App.tsx's routing: a successful login navigates to "/" and
    // LoginPage actually unmounts, the way it does in production.
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/login"]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<p>Home page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
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
    // A successful login now does a full `queryClient.clear()` (see below),
    // which leaves the still-mounted `["config"]` query without cached data
    // for a moment and triggers an incidental background refetch before the
    // route swap unmounts LoginPage — queue a response so that refetch
    // doesn't hit an empty mock.
    apiFetchMock.mockResolvedValueOnce({
      authMode: "dev",
      directLoginMethods: ["externalbrowser", "password"],
    });
    await userEvent.type(screen.getByLabelText(/account/i), "myorg-myaccount");
    await userEvent.type(screen.getByLabelText(/user/i), "alice");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/auth/dev-login", {
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
    // Queue a response for the incidental `["config"]` background refetch
    // that the post-login `queryClient.clear()` triggers on the
    // still-mounted observer before LoginPage unmounts (see comment above).
    apiFetchMock.mockResolvedValueOnce({
      authMode: "dev",
      directLoginMethods: ["externalbrowser", "keypair"],
    });
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      const devLoginCall = apiFetchMock.mock.calls.find(([path]) => path === "/auth/dev-login");
      const body = JSON.parse(devLoginCall![1]!.body as string);
      expect(body.authenticator).toBe("keypair");
      expect(body.private_key_pem).toBe("PEMDATA");
    });
  });

  it("clears the PEM from state after a rejected keypair login", async () => {
    apiFetchMock.mockResolvedValueOnce({
      authMode: "dev",
      directLoginMethods: ["externalbrowser", "keypair"],
    });
    renderPage();
    await screen.findByLabelText(/account/i);
    await userEvent.selectOptions(screen.getByLabelText(/authenticator/i), "keypair");
    await userEvent.type(screen.getByLabelText(/account/i), "acct");
    await userEvent.type(screen.getByLabelText(/^user/i), "alice");
    const textarea = screen.getByLabelText(/private key/i);
    await userEvent.type(textarea, "PEMDATA");
    apiFetchMock.mockRejectedValueOnce(
      new ApiError(
        "AUTH_FAILED",
        401,
        "Could not read the private key. Check the PEM and passphrase.",
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/re-paste your private key/i);
    });
    expect(textarea).toHaveValue("");
  });

  it("shows Snowflake's own reason for a rejected password login", async () => {
    apiFetchMock.mockResolvedValueOnce({
      authMode: "dev",
      directLoginMethods: ["externalbrowser", "password"],
    });
    renderPage();
    await screen.findByLabelText(/account/i);
    await userEvent.selectOptions(screen.getByLabelText(/authenticator/i), "password");
    await userEvent.type(screen.getByLabelText(/account/i), "acct");
    await userEvent.type(screen.getByLabelText(/^user/i), "alice");
    await userEvent.type(screen.getByLabelText(/^password/i), "hunter2");
    apiFetchMock.mockRejectedValueOnce(
      new ApiError(
        "AUTH_FAILED",
        401,
        "Snowflake login failed",
        "250001 (08001): Failed to connect to DB: acct.snowflakecomputing.com:443. " +
          "Incorrect username or password was specified.",
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      // The generic message alone is useless — the caller needs the actual cause.
      expect(screen.getByRole("alert")).toHaveTextContent(
        /incorrect username or password was specified/i,
      );
    });
  });

  it("falls back to the generic message when no detail is supplied", async () => {
    apiFetchMock.mockResolvedValueOnce({
      authMode: "dev",
      directLoginMethods: ["externalbrowser", "password"],
    });
    renderPage();
    await screen.findByLabelText(/account/i);
    await userEvent.type(screen.getByLabelText(/account/i), "acct");
    await userEvent.type(screen.getByLabelText(/^user/i), "alice");
    apiFetchMock.mockRejectedValueOnce(
      new ApiError("AUTH_FAILED", 401, "Snowflake login failed", null),
    );
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/snowflake login failed/i);
    });
  });

  it("clears the whole query client cache on a successful login, not just [me]", async () => {
    apiFetchMock.mockResolvedValueOnce({
      authMode: "dev",
      directLoginMethods: ["externalbrowser"],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Simulate a browser that still holds a previous identity's cache
    // (e.g. user A's semantic-views list) when user B logs in.
    qc.setQueryData(["semantic-views"], { views: [{ name: "A's view" }] });
    renderPage(qc);
    await screen.findByLabelText(/account/i);
    apiFetchMock.mockResolvedValueOnce({
      snowflakeUser: "BOB", snowflakeAccount: "ACME", mode: "dev",
    });
    await userEvent.type(screen.getByLabelText(/account/i), "myorg-myaccount");
    await userEvent.type(screen.getByLabelText(/user/i), "bob");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      expect(qc.getQueryData(["semantic-views"])).toBeUndefined();
    });
  });
});
