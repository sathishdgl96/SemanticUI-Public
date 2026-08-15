import { useEffect, useState } from "react";
import { exportReport } from "../api/reports";

interface Props {
  reportId: string;
  onClose: () => void;
}

/** Plain fetch-on-mount rather than a `useQuery` — this panel has no
 *  `QueryClientProvider` above it (it can be opened from `BuilderPage`,
 *  which does have one, but the panel is meant to stand alone, and its own
 *  test renders it bare), so it manages its own request lifecycle instead. */
export default function ExportPanel({ reportId, onClose }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    exportReport(reportId)
      .then((document) => {
        if (!cancelled) setText(document);
      })
      .catch(() => {
        if (!cancelled) setError("Could not export this report.");
      });
    return () => {
      cancelled = true;
    };
  }, [reportId]);

  async function copy() {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage("Copied to clipboard.");
    } catch {
      setCopyMessage("Copy is unavailable in this browser — select the text and copy manually.");
    }
  }

  return (
    <div className="panel" role="dialog" aria-label="Export report">
      <header className="panel-head">
        <h3>Export</h3>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      <label className="panel-field">
        Report definition
        <textarea readOnly value={text ?? ""} />
      </label>
      <div className="panel-actions">
        <button type="button" onClick={copy} disabled={text === null}>
          Copy
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
      {copyMessage && <p className="notice">{copyMessage}</p>}
    </div>
  );
}
