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

  it("throws ApiError built from the error envelope", async () => {
    mockFetch(400, { code: "QUERY_ERROR", message: "bad field", detail: null });
    const err = await apiFetch("/api/query/semantic").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("QUERY_ERROR");
    expect(err.message).toBe("bad field");
    expect(err.status).toBe(400);
  });

  it("fires the auth-expired handler on 401", async () => {
    mockFetch(401, { code: "AUTH_EXPIRED", message: "Sign in required", detail: null });
    const handler = vi.fn();
    setOnAuthExpired(handler);
    const err = await apiFetch("/api/me").catch((e) => e);
    expect(handler).toHaveBeenCalledOnce();
    expect(err.code).toBe("AUTH_EXPIRED");
  });
});
