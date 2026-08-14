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

let authExpiredHandler: (() => void) | null = null;

export function setOnAuthExpired(handler: (() => void) | null): void {
  authExpiredHandler = handler;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers,
  });
  if (response.status === 401) {
    let body: { code?: string; message?: string; detail?: string | null } = {};
    try {
      body = await response.json();
    } catch {
      // non-JSON error body; fall through to defaults
    }
    authExpiredHandler?.();
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
  return (await response.json()) as T;
}
