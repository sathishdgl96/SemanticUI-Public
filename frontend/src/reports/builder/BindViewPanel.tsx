import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "../../api/client";
import type { SemanticViewSummary } from "../../api/types";
import ViewTree from "../../explorer/ViewTree";

/** Shared by both "no view bound yet" (fresh report) and "the bound view no
 *  longer resolves" (deleted/forbidden) — both cases hand the user the same
 *  view tree so binding to a replacement view is one consistent flow. */
export default function BindViewPanel({
  reason,
  onBind,
  canEdit,
  binding,
  bindError,
}: {
  reason: string | null;
  onBind: (view: SemanticViewSummary) => void;
  canEdit: boolean;
  binding: boolean;
  bindError: string | null;
}) {
  const [open, setOpen] = useState(reason === null);
  const views = useQuery({
    queryKey: ["semantic-views"],
    queryFn: () => apiFetch<{ views: SemanticViewSummary[] }>("/api/semantic-views"),
    enabled: open && canEdit,
  });

  // A viewer cannot write to the report, so offering the picker would only
  // produce a 403 at the end of a hopeful click.
  if (!canEdit) {
    return (
      <div className="builder-bind">
        <p role="alert">
          {reason ??
            "This report has no semantic view yet, and only an editor can choose one."}
        </p>
      </div>
    );
  }

  return (
    <div className="builder-bind">
      {reason ? (
        <>
          <p role="alert">{reason}</p>
          {!open && (
            <button type="button" onClick={() => setOpen(true)}>
              Choose another view
            </button>
          )}
        </>
      ) : (
        // Says that choosing SAVES, because it does -- and because the state
        // this replaces was one where the report looked bound and the server
        // disagreed.
        <p>Pick a semantic view to start this report. Choosing one saves it.</p>
      )}
      {bindError && <p role="alert">{bindError}</p>}
      {binding && <p className="tile-hint">Saving the view to this report…</p>}
      {open && (
        <>
          {views.isLoading && <p>Loading views…</p>}
          {views.isError && <p role="alert">Could not load semantic views.</p>}
          {views.data && <ViewTree views={views.data.views} selected={null} onSelect={onBind} />}
        </>
      )}
    </div>
  );
}
