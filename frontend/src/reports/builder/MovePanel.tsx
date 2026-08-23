import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../../api/client";
import { atLeast, moveReport } from "../../api/workspaces";
import { useWorkspaces } from "../../workspaces/useWorkspaces";

/** Only workspaces the caller can write to are offered. Moving needs editor
 *  on BOTH ends, so listing a read-only workspace would only produce a 403. */
export default function MovePanel({ reportId, onDone }: { reportId: string; onDone: () => void }) {
  const workspaces = useWorkspaces();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState("");

  const move = useMutation({
    mutationFn: () => moveReport(reportId, target),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      queryClient.invalidateQueries({ queryKey: ["report", reportId] });
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      onDone();
    },
  });

  const writable = (workspaces.data?.workspaces ?? []).filter((w) =>
    atLeast(w.myRole, "editor"),
  );

  return (
    <form
      className="move-panel"
      onSubmit={(e) => {
        e.preventDefault();
        if (target) move.mutate();
      }}
    >
      <label>
        Move to
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose a workspace…</option>
          {writable.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={!target || move.isPending}>
        {move.isPending ? "Moving…" : "Move report"}
      </button>
      <button type="button" className="link" onClick={onDone}>
        Cancel
      </button>
      {move.isError && (
        <p role="alert">
          {move.error instanceof ApiError
            ? move.error.message
            : "Could not move this report."}
        </p>
      )}
    </form>
  );
}
