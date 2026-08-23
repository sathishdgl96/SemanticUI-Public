import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { createWorkspace } from "../api/workspaces";
import { useWorkspaces } from "../workspaces/useWorkspaces";
import CloseButton from "../ui/CloseButton";

/** The PowerBI-style workspaces panel, opened from the nav rail.
 *
 *  Selecting a workspace navigates to /reports?workspace=<id>, so the flyout
 *  and the workspace page share the URL as their one source of truth. */
export default function WorkspacesFlyout({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspaces = useWorkspaces();
  const nameId = useId();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  // Escape closes from anywhere: after clicking the rail button, focus is
  // still ON that button, so a listener scoped to the panel never hears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = useMutation({
    mutationFn: () => createWorkspace(name),
    onSuccess: (workspace) => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setCreating(false);
      setName("");
      navigate(`/reports?workspace=${encodeURIComponent(workspace.id)}`);
      onClose();
    },
  });

  const open = (id: string) => {
    navigate(`/reports?workspace=${encodeURIComponent(id)}`);
    onClose();
  };

  return (
    <div
      className="ws-flyout"
      role="dialog"
      aria-label="Workspaces"
    >
      <header className="ws-flyout-head">
        <h2>Workspaces</h2>
        <CloseButton onClick={onClose} />
      </header>

      {workspaces.isLoading && <p className="tile-hint">Loading workspaces…</p>}
      {workspaces.isError && <p role="alert">Could not load your workspaces.</p>}

      <ul className="ws-flyout-list">
        {(workspaces.data?.workspaces ?? []).map((workspace) => (
          <li key={workspace.id}>
            <button
              type="button"
              className="ws-flyout-item"
              onClick={() => open(workspace.id)}
            >
              <span className="ws-glyph" aria-hidden="true">
                {workspace.kind === "personal" ? "🔒" : "▦"}
              </span>
              <span className="ws-name">{workspace.name}</span>
              <span className="ws-meta">
                {workspace.myRole} · {workspace.reportCount} report
                {workspace.reportCount === 1 ? "" : "s"}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {!creating && (
        <button type="button" className="secondary" onClick={() => setCreating(true)}>
          New workspace
        </button>
      )}
      {creating && (
        <form
          className="workspace-create"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <label htmlFor={nameId}>Workspace name</label>
          <input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <button type="submit" disabled={!name.trim() || create.isPending}>
            Create
          </button>
          <button type="button" className="link" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </form>
      )}
      {create.isError && (
        <p role="alert">
          {create.error instanceof ApiError
            ? create.error.message
            : "Could not create that workspace."}
        </p>
      )}
    </div>
  );
}
