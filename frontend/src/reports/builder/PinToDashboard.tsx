import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../../api/client";
import { addTile, createDashboard, listDashboards } from "../../api/dashboards";

/**
 * Choose which dashboard a visual is pinned to.
 *
 * Only dashboards in the REPORT's workspace are offered: a tile may not
 * name a report outside its dashboard's workspace, so listing the others
 * would be offering a choice the server is going to refuse.
 */
export default function PinToDashboard({
  reportId,
  workspaceId,
  pageId,
  visualId,
  visualTitle,
  onClose,
}: {
  reportId: string;
  workspaceId: string;
  pageId: string;
  visualId: string;
  visualTitle: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const dashboards = useQuery({
    queryKey: ["dashboards", workspaceId],
    queryFn: () => listDashboards(workspaceId),
  });

  const done = () => {
    queryClient.invalidateQueries({ queryKey: ["dashboards"] });
    queryClient.invalidateQueries({ queryKey: ["home"] });
    onClose();
  };

  const pin = useMutation({
    mutationFn: (dashboardId: string) =>
      addTile(dashboardId, { reportId, pageId, visualId }),
    onSuccess: done,
  });

  const createAndPin = useMutation({
    mutationFn: async () => {
      const dashboard = await createDashboard(newName.trim(), workspaceId);
      return addTile(dashboard.id, { reportId, pageId, visualId });
    },
    onSuccess: done,
  });

  const listed = dashboards.data?.dashboards ?? [];
  const error = pin.error ?? createAndPin.error;
  const busy = pin.isPending || createAndPin.isPending;

  return (
    <div className="panel" role="dialog" aria-label="Pin to dashboard">
      <header className="panel-head">
        <h2>Pin “{visualTitle}”</h2>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </header>

      {dashboards.isLoading && <p className="tile-hint">Loading dashboards…</p>}
      {dashboards.data && listed.length === 0 && !creating && (
        <p className="tile-hint">
          This workspace has no dashboards yet. Create the first one.
        </p>
      )}

      {listed.length > 0 && (
        <ul className="pin-target-list">
          {listed.map((dashboard) => (
            <li key={dashboard.id}>
              <button
                type="button"
                className="pin-target"
                disabled={busy}
                onClick={() => pin.mutate(dashboard.id)}
              >
                <span className="pin-target-name">{dashboard.name}</span>
                <span className="pin-target-meta">
                  {dashboard.tileCount} tile{dashboard.tileCount === 1 ? "" : "s"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <form
          className="workspace-create"
          onSubmit={(event) => {
            event.preventDefault();
            if (newName.trim()) createAndPin.mutate();
          }}
        >
          <label htmlFor="new-dashboard-name">New dashboard name</label>
          <input
            id="new-dashboard-name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            autoFocus
          />
          <button type="submit" disabled={!newName.trim() || busy}>
            Create and pin
          </button>
          <button type="button" className="link" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" className="secondary" onClick={() => setCreating(true)}>
          New dashboard…
        </button>
      )}

      {error && (
        <p role="alert">
          {error instanceof ApiError ? error.message : "Could not pin this visual."}
        </p>
      )}
    </div>
  );
}
