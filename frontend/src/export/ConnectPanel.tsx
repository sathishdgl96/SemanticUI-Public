import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../api/client";
import { createConnectToken, downloadOdc, fetchConnectDetails } from "../api/exports";
import type { SheetRequest } from "../api/types";

interface Props {
  reportId: string;
  sheets: SheetRequest[];
  /** The visuals a Power Query URL can serve -- everything but slicers. */
  feedVisuals?: { id: string; title: string }[];
  onClose: () => void;
}

export default function ConnectPanel({ reportId, sheets, feedVisuals = [], onClose }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const details = useQuery({
    queryKey: ["connect", reportId, sheets],
    queryFn: () => fetchConnectDetails(reportId, sheets),
  });

  // The token appears exactly once, right here; only its hash exists
  // server-side, so there is nothing to re-fetch later.
  const mintToken = useMutation({ mutationFn: createConnectToken });

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

      {/* The ZERO-INSTALL path: stock Excel's own Power Query, no driver,
          no admin, no add-in. First in the panel because it is the only
          route that works on a locked-down machine -- everything below
          needs the Snowflake ODBC driver installed. */}
      {feedVisuals.length > 0 && (
        <section className="connect-feed">
          <h4>Power Query — works with nothing installed</h4>
          <div className="connect-sql-head">
            <strong>Connection token</strong>
            {mintToken.data ? (
              <span className="connect-actions">
                <code>{mintToken.data.token}</code>
                <button
                  type="button"
                  className="link"
                  aria-label="Copy connection token"
                  onClick={() => copy("connect-token", mintToken.data.token)}
                >
                  {copied === "connect-token" ? "Copied" : "Copy token"}
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => mintToken.mutate()}
                disabled={mintToken.isPending}
              >
                {mintToken.isPending ? "Creating…" : "Create token"}
              </button>
            )}
          </div>
          {mintToken.isError && (
            <p role="alert">
              {mintToken.error instanceof ApiError
                ? mintToken.error.message
                : "Could not create a token."}
            </p>
          )}
          <p className="tile-hint">
            The token stands in for your password in Excel — it is shown only
            once, lives at most a day, dies when you sign out, and creating a
            new one replaces it. Your Snowflake password never goes into
            Excel.
          </p>
          <ol className="connect-steps">
            <li>In Excel: Data → From Web → paste a URL below.</li>
            <li>
              Choose <strong>Basic</strong>: username <code>token</code>,
              password the connection token above.
            </li>
            <li>Load. Data → Refresh All re-runs the query as you.</li>
          </ol>
          {feedVisuals.map((visual) => {
            const url = `${window.location.origin}/api/feed/reports/${encodeURIComponent(
              reportId,
            )}/visuals/${encodeURIComponent(visual.id)}.csv`;
            return (
              <div key={visual.id} className="connect-sql-head">
                <strong>{visual.title || "Untitled visual"}</strong>
                <button
                  type="button"
                  className="link"
                  aria-label={`Copy feed URL for ${visual.title || visual.id}`}
                  onClick={() => copy(`feed:${visual.id}`, url)}
                >
                  {copied === `feed:${visual.id}` ? "Copied" : "Copy URL"}
                </button>
              </div>
            );
          })}
          <p className="tile-hint">
            Add <code>?f.TABLE.FIELD=value</code> to a URL to slice it — point
            it at a worksheet cell in Power Query and the cell drives the
            query, whatever the data volume.
          </p>
        </section>
      )}

      {/* The PivotTable path: a real OLAP connection over the same token.
          Excel treats the semantic view as a cube — drag fields, drill,
          slice, filter, and every query runs live on your connection. */}
      <section className="connect-feed">
        <h4>PivotTable — live cube via Analysis Services</h4>
        <ol className="connect-steps">
          <li>
            In Excel: Data → Get Data → From Database → From Analysis
            Services.
          </li>
          <li>
            Server name: <code>{`${window.location.origin}/xmla`}</code>
          </li>
          <li>
            Choose "Use the following User Name and Password": username{" "}
            <code>token</code>, password the connection token above.
          </li>
          <li>
            Pick your semantic view from the cube list and Finish — Excel
            builds a PivotTable with your entities as fields and metrics as
            measures. Drill, slice and filter run live on Snowflake as you.
          </li>
        </ol>
      </section>


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
