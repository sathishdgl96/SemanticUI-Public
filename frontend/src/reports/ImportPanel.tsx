import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../api/client";
import { importReport } from "../api/reports";
import type { ReportDetail, ViewRef } from "../api/types";

interface Props {
  onImported: (report: ReportDetail) => void;
  onClose: () => void;
}

/** `useMutation` (not a manually-tracked `pending` flag with a hand-rolled
 *  try/catch) so closing this panel mid-request can never call `setState`
 *  on an unmounted component: react-query keeps mutation state in its own
 *  external store and only notifies a component that's still subscribed,
 *  rather than this component's own promise handler touching local state
 *  directly after `onClose` has already unmounted it. */
export default function ImportPanel({ onImported, onClose }: Props) {
  const [text, setText] = useState("");
  const [database, setDatabase] = useState("");
  const [schema, setSchema] = useState("");
  const [view, setView] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);

  const importMutation = useMutation({
    mutationFn: (payload: { parsed: unknown; override?: ViewRef }) =>
      importReport(payload.parsed, payload.override),
    onSuccess: (report) => onImported(report),
  });

  function submit() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setParseError("That is not valid JSON.");
      return;
    }
    setParseError(null);
    const override: ViewRef | undefined =
      database.trim() && schema.trim() && view.trim()
        ? { database: database.trim(), schema: schema.trim(), name: view.trim() }
        : undefined;
    importMutation.mutate({ parsed, override });
  }

  const error =
    parseError ??
    (importMutation.isError
      ? importMutation.error instanceof ApiError
        ? importMutation.error.message
        : "Import failed"
      : null);

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
        <button type="button" onClick={submit} disabled={importMutation.isPending}>
          {importMutation.isPending ? "Importing…" : "Import"}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
