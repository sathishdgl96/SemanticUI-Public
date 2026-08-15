export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public detail?: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let authExpiredHandler: ((reason?: string) => void) | null = null;

/** Registers the redirect-to-login handler. It receives the backend's own
 *  explanation so the login page can say why the user was sent back, rather
 *  than appearing to drop the session for no reason. */
export function setOnAuthExpired(handler: ((reason?: string) => void) | null): void {
  authExpiredHandler = handler;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    // Spread after `...init` so a caller-supplied `init.credentials` can
    // never override this security-relevant default.
    credentials: "same-origin",
    headers,
  });
  if (response.status === 401) {
    let body: { code?: string; message?: string; detail?: string | null } = {};
    try {
      body = await response.json();
    } catch {
      // non-JSON error body; fall through to defaults
    }
    authExpiredHandler?.(body.message);
    throw new ApiError(
      body.code ?? "AUTH_EXPIRED",
      401,
      body.message ?? "Sign in required",
      body.detail,
    );
  }
  if (!response.ok) {
    let body: { code?: string; message?: string; detail?: string | null } = {};
    try {
      body = await response.json();
    } catch {
      // non-JSON error body; fall through to defaults
    }
    throw new ApiError(
      body.code ?? "QUERY_ERROR",
      response.status,
      body.message ?? response.statusText,
      body.detail,
    );
  }
  // 204 No Content (DELETE /api/reports/{id}, for one) has no body for
  // response.json() to parse — it throws "Unexpected end of JSON input" on
  // the empty string, which would fail the request client-side even though
  // the server completed it. Read as text first and treat any empty body
  // (204 or otherwise) as "no payload" rather than a parse error, so every
  // present and future no-content endpoint gets the same protection.
  const text = await response.text();
  if (response.status === 204 || text.length === 0) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}
