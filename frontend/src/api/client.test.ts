import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, setOnAuthExpired } from "./client";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setOnAuthExpired(null);
});

describe("apiFetch", () => {
  it("returns parsed JSON on success", async () => {
    mockFetch(200, { authMode: "dev" });
    await expect(apiFetch("/api/config")).resolves.toEqual({ authMode: "dev" });
  });

  it("resolves instead of throwing on a 204 No Content response", async () => {
    // DELETE /api/reports/{id} returns 204 with no body; response.json()
    // would throw SyntaxError on the empty string, which would surface as
    // a failed delete client-side even though the server deleted it.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(apiFetch("/api/reports/r1", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("still parses a normal JSON body alongside the 204 guard", async () => {
    mockFetch(200, { reports: [] });
    await expect(apiFetch("/api/reports")).resolves.toEqual({ reports: [] });
  });

  it("sends JSON body with same-origin credentials", async () => {
    const fn = mockFetch(200, { ok: true });
    await apiFetch("/auth/dev-login", {
      method: "POST",
      body: JSON.stringify({ account: "a" }),
    });
    const [, init] = fn.mock.calls[0];
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("does not let a caller-supplied init.credentials override same-origin", async () => {
    const fn = mockFetch(200, { ok: true });
    await apiFetch("/api/config", { credentials: "include" });
    const [, init] = fn.mock.calls[0];
    expect(init.credentials).toBe("same-origin");
  });

  it("throws ApiError built from the error envelope", async () => {
    mockFetch(400, { code: "QUERY_ERROR", message: "bad field", detail: null });
    const err = await apiFetch<never>("/api/query/semantic").catch((e: unknown) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("QUERY_ERROR");
    expect(err.message).toBe("bad field");
    expect(err.status).toBe(400);
  });

  it("fires the auth-expired handler on 401", async () => {
    mockFetch(401, { code: "AUTH_EXPIRED", message: "Sign in required", detail: null });
    const handler = vi.fn();
    setOnAuthExpired(handler);
    const err = await apiFetch<never>("/api/me").catch((e: unknown) => e as ApiError);
    expect(handler).toHaveBeenCalledOnce();
    expect(err.code).toBe("AUTH_EXPIRED");
  });

  it("preserves the backend envelope message on 401", async () => {
    mockFetch(401, {
      code: "AUTH_EXPIRED",
      message: "Dev session connection lost; sign in again",
      detail: null,
    });
    const handler = vi.fn();
    setOnAuthExpired(handler);
    const err = await apiFetch<never>("/api/me").catch((e: unknown) => e as ApiError);
    expect(handler).toHaveBeenCalledOnce();
    expect(err.message).toBe("Dev session connection lost; sign in again");
  });
});

describe("auth-expired handler", () => {
  it("passes the backend's reason to the handler", async () => {
    mockFetch(401, {
      code: "AUTH_EXPIRED",
      message: "Dev session connection lost; sign in again",
      detail: null,
    });
    const handler = vi.fn();
    setOnAuthExpired(handler);
    await apiFetch<never>("/api/semantic-views").catch((e: unknown) => e as ApiError);
    // Without the reason the login page can only show a blank redirect, which
    // reads to the user as the session silently failing.
    expect(handler).toHaveBeenCalledWith("Dev session connection lost; sign in again");
  });
});
