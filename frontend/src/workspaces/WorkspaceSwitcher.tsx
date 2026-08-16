import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../api/client";
import { createWorkspace } from "../api/workspaces";
import { useWorkspaces } from "./useWorkspaces";

interface Props {
  value: string;
  onChange: (workspaceId: string) => void;
  onCreated: (workspaceId: string) => void;
  onManageMembers: () => void;
}

export default function WorkspaceSwitcher({
  value,
  onChange,
  onCreated,
  onManageMembers,
}: Props) {
  const workspaces = useWorkspaces();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () => createWorkspace(name),
    onSuccess: (workspace) => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setCreating(false);
      setName("");
      onCreated(workspace.id);
    },
  });

  const rows = workspaces.data?.workspaces ?? [];
  const selected = rows.find((w) => w.id === value);

  return (
    <div className="workspace-switcher">
      <label>
        Workspace
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {rows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>

      {selected && (
        <span className="workspace-role">
          You are {selected.myRole === "admin" ? "an" : "a"} {selected.myRole} here
        </span>
      )}

      {/* A personal workspace has no membership to manage -- that is what
          makes it personal -- so the control is absent rather than disabled.
          A disabled button would imply there is something to reveal. */}
      {selected?.kind === "shared" && (
        <button type="button" className="link" onClick={onManageMembers}>
          Members ({selected.memberCount})
        </button>
      )}

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
          <label>
            Workspace name
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <button type="submit" disabled={!name.trim() || create.isPending}>
            Create
          </button>
          <button type="button" className="link" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </form>
      )}

      {workspaces.isError && <p role="alert">Could not load your workspaces.</p>}
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
