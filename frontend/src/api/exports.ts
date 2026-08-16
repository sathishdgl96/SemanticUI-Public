import { ApiError, apiFetch } from "./client";
import type { ConnectResponse, SheetRequest } from "./types";

export function fetchConnectDetails(
  reportId: string,
  sheets: SheetRequest[],
): Promise<ConnectResponse> {
  return apiFetch<ConnectResponse>(
    `/api/reports/${encodeURIComponent(reportId)}/connect`,
    { method: "POST", body: JSON.stringify({ sheets }) },
  );
}

/** Not apiFetch: the response is a binary workbook rather than JSON, so it
 *  needs the raw fetch. `credentials` is still same-origin -- the export runs
 *  every visual's query on the user's own Snowflake connection and therefore
 *  needs their session. */
export async function downloadXlsx(
  reportId: string,
  sheets: SheetRequest[],
  filename: string,
): Promise<void> {
  const response = await fetch(
    `/api/reports/${encodeURIComponent(reportId)}/export.xlsx`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sheets }),
    },
  );

  if (!response.ok) {
    let body: { message?: string; code?: string } = {};
    try {
      body = await response.json();
    } catch {
      // A non-JSON error body; fall through to the default message.
    }
    throw new ApiError(
      body.code ?? "QUERY_ERROR",
      response.status,
      body.message ?? "Could not export this report.",
    );
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
