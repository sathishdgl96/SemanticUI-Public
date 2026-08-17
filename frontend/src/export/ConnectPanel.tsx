import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../api/client";
import { downloadOdc, fetchConnectDetails } from "../api/exports";
import type { SheetRequest } from "../api/types";

interface Props {
  reportId: string;
  sheets: SheetRequest[];
  onClose: () => void;
}

export default function ConnectPanel({ reportId, sheets, onClose }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const details = useQuery({
    queryKey: ["connect", reportId, sheets],
    queryFn: () => fetchConnectDetails(reportId, sheets),
  });

  // One file per query, because one ODC holds one query -- which is also one
  // table in Excel, so the mapping is the one a person expects.
  const download = useMutation({
    mutationFn: (sheet: SheetRequest) =>
      downloadOdc(reportId, sheet, `${sheet.title || "query"}.odc`),
  });

  const copy = (title: string, sql: string) => {
    navigator.clipboard?.writeText(sql);
    setCopied(title);
  };

  return (
    <section className="connect-panel" aria-label="Connect from Excel">
      <header>
        <h3>Connect live from Excel</h3>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </header>

      <p className="tile-hint">
        Either way, the workbook refreshes straight from Snowflake as you, and
        no data passes through this application once it is connected.
      </p>

      {details.isLoading && <p className="tile-hint">Building the statements…</p>}
      {details.isError && (
        <p role="alert">
          {details.error instanceof ApiError
            ? details.error.message
            : "Could not build the connection details."}
        </p>
      )}
      {download.isError && (
        <p role="alert">
          {download.error instanceof ApiError
            ? download.error.message
            : "Could not build a connection file."}
        </p>
      )}

      {details.data?.sheets.map((sheet, index) => (
        <div key={sheet.title} className="connect-sql">
          <div className="connect-sql-head">
            <strong>{sheet.title}</strong>
            <span className="connect-actions">
              {/* The short way, offered first because it is the one most
                  people want: a file Excel opens into a connected table. */}
              {/* Short on screen, specific to a screen reader: with four
                  visuals listed, four buttons all called "Copy SQL" name
                  nothing. The accessible name contains the visible text, so
                  saying "copy SQL" to a voice control still works. */}
              <button
                type="button"
                aria-label={`Download .odc for ${sheet.title}`}
                onClick={() => download.mutate(sheets[index])}
                disabled={download.isPending}
              >
                {download.isPending ? "Building…" : "Download .odc"}
              </button>
              <button
                type="button"
                className="link"
                aria-label={`Copy SQL for ${sheet.title}`}
                onClick={() => copy(sheet.title, sheet.sql)}
              >
                {copied === sheet.title ? "Copied" : "Copy SQL"}
              </button>
            </span>
          </div>
          <pre>{sheet.sql}</pre>
        </div>
      ))}

      {/* The manual route stays, and is honest about the one thing the file
          needs that a paste does not. */}
      <details className="connect-manual">
        <summary>Connect by hand instead</summary>
        <ol className="connect-steps">
          <li>In Excel: Data → Get Data → From Database → From Snowflake.</li>
          <li>
            Server: <code>{details.data?.account ?? "…"}.snowflakecomputing.com</code>
          </li>
          <li>Sign in with your own Snowflake credentials.</li>
          <li>Open Advanced options and paste one of the statements above.</li>
        </ol>
        <p className="tile-hint">
          Worth knowing: the .odc file reaches Snowflake through the Snowflake
          ODBC driver, so it needs that driver installed on the machine opening
          it. The manual route uses Excel's own built-in connector and needs
          nothing extra — which is why both are here.
        </p>
      </details>
    </section>
  );
}
