import { useState } from "react";
import { ApiError } from "../api/client";
import { importReport } from "../api/reports";
import type { ReportDetail, ViewRef } from "../api/types";

interface Props {
  onImported: (report: ReportDetail) => void;
  onClose: () => void;
}

/** Plain state + a submit handler, not `useMutation` — same reasoning as
 *  `ExportPanel`: this panel's own test renders it with no
 *  `QueryClientProvider` above it. */
export default function ImportPanel({ onImported, onClose }: Props) {
  const [text, setText] = useState("");
  const [database, setDatabase] = useState("");
  const [schema, setSchema] = useState("");
  const [view, setView] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError("That is not valid JSON.");
      return;
    }
    setError(null);
    setPending(true);
    const override: ViewRef | undefined =
      database.trim() && schema.trim() && view.trim()
        ? { database: database.trim(), schema: schema.trim(), name: view.trim() }
        : undefined;
    try {
      const report = await importReport(parsed, override);
      onImported(report);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Import failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="panel" role="dialog" aria-label="Import report">
      <header className="panel-head">
        <h3>Import</h3>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      <label className="panel-field">
        Paste a report definition
        <textarea value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="panel-grid">
        <label className="panel-field">
          Database
          <input value={database} onChange={(e) => setDatabase(e.target.value)} />
        </label>
        <label className="panel-field">
          Schema
          <input value={schema} onChange={(e) => setSchema(e.target.value)} />
        </label>
        <label className="panel-field">
          View
          <input value={view} onChange={(e) => setView(e.target.value)} />
        </label>
      </div>
      <div className="panel-actions">
        <button type="button" onClick={submit} disabled={pending}>
          {pending ? "Importing…" : "Import"}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
