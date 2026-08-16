import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../api/client";
import { fetchConnectDetails } from "../api/exports";
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

      <ol className="connect-steps">
        <li>In Excel: Data → Get Data → From Database → From Snowflake.</li>
        <li>
          Server: <code>{details.data?.account ?? "…"}.snowflakecomputing.com</code>
        </li>
        <li>Sign in with your own Snowflake credentials.</li>
        <li>Open Advanced options and paste one of the statements below.</li>
      </ol>

      <p className="tile-hint">
        The workbook then refreshes straight from Snowflake as you. No data
        passes through this application once it is connected.
      </p>

      {details.isLoading && <p className="tile-hint">Building the statements…</p>}
      {details.isError && (
        <p role="alert">
          {details.error instanceof ApiError
            ? details.error.message
            : "Could not build the connection details."}
        </p>
      )}

      {details.data?.sheets.map((sheet) => (
        <div key={sheet.title} className="connect-sql">
          <div className="connect-sql-head">
            <strong>{sheet.title}</strong>
            <button
              type="button"
              className="link"
              onClick={() => copy(sheet.title, sheet.sql)}
            >
              {copied === sheet.title ? "Copied" : `Copy SQL for ${sheet.title}`}
            </button>
          </div>
          <pre>{sheet.sql}</pre>
        </div>
      ))}
    </section>
  );
}
