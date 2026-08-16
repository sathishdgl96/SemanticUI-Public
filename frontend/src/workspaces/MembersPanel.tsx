import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ApiError } from "../api/client";
import type { Role } from "../api/types";
import { addMember, listMembers, removeMember, setMemberRole } from "../api/workspaces";

const ROLE_OPTIONS: Role[] = ["viewer", "editor", "admin"];

interface Props {
  workspaceId: string;
  myRole: Role;
  onClose: () => void;
}

export default function MembersPanel({ workspaceId, myRole, onClose }: Props) {
  const queryClient = useQueryClient();
  const members = useQuery({
    queryKey: ["workspace-members", workspaceId],
    queryFn: () => listMembers(workspaceId),
  });
  const [username, setUsername] = useState("");
  const [newRole, setNewRole] = useState<Role>("viewer");
  // Explicit ids, not wrapping labels: a <label> around a <select> folds the
  // option text into the control's accessible name, so it reads as
  // "Role for BOBviewereditoradmin" in a real browser.
  const usernameId = useId();
  const newRoleId = useId();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["workspace-members", workspaceId] });
    // Membership changes the member count the switcher shows.
    queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    // And it can change what reports the caller may see, if they removed
    // themselves from a workspace they were reading.
    queryClient.invalidateQueries({ queryKey: ["reports"] });
  };

  const add = useMutation({
    mutationFn: () => addMember(workspaceId, username.trim(), newRole),
    onSuccess: () => {
      setUsername("");
      refresh();
    },
  });
  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      setMemberRole(workspaceId, userId, role),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => removeMember(workspaceId, userId),
    onSuccess: refresh,
  });

  const rows = members.data?.members ?? [];
  const admins = rows.filter((m) => m.role === "admin").length;
  const canManage = myRole === "admin";
  const failure = add.error ?? changeRole.error ?? remove.error;

  return (
    <section className="members-panel" aria-label="Workspace members">
      <header>
        <h3>Members</h3>
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </header>

      {members.isLoading && <p className="tile-hint">Loading members…</p>}
      {members.isError && <p role="alert">Could not load members.</p>}

      <ul className="member-list">
        {rows.map((member) => {
          // The server refuses to remove or demote the last admin. Disabling
          // with a stated reason beats letting someone try and be rejected.
          const isLastAdmin = member.role === "admin" && admins === 1;
          return (
            <li key={member.userId}>
              <span className="member-name">
                {member.snowflakeUser}
                {member.isMe && <small> (you)</small>}
              </span>
              {canManage ? (
                <>
                  <label htmlFor={`role-${member.userId}`}>
                    Role for {member.snowflakeUser}
                  </label>
                  <select
                    id={`role-${member.userId}`}
                    value={member.role}
                    disabled={isLastAdmin}
                    onChange={(e) =>
                      changeRole.mutate({
                        userId: member.userId,
                        role: e.target.value as Role,
                      })
                    }
                  >
                    {ROLE_OPTIONS.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="link"
                    disabled={isLastAdmin}
                    onClick={() => remove.mutate(member.userId)}
                  >
                    Remove {member.snowflakeUser}
                  </button>
                  {isLastAdmin && (
                    <small className="tile-hint">
                      The last admin cannot be removed or demoted. Promote someone
                      else first.
                    </small>
                  )}
                </>
              ) : (
                <span className="member-role">{member.role}</span>
              )}
            </li>
          );
        })}
      </ul>

      {canManage ? (
        <form
          className="member-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (username.trim()) add.mutate();
          }}
        >
          <label htmlFor={usernameId}>Snowflake username</label>
          <input
            id={usernameId}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <label htmlFor={newRoleId}>Role for the new member</label>
          <select
            id={newRoleId}
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as Role)}
          >
            {ROLE_OPTIONS.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
          <button type="submit" disabled={!username.trim() || add.isPending}>
            Add
          </button>
        </form>
      ) : (
        <p className="tile-hint">Only an admin can change who is in this workspace.</p>
      )}

      {failure && (
        <p role="alert">
          {failure instanceof ApiError ? failure.message : "That did not work."}
        </p>
      )}

      <p className="tile-hint">
        Members see this workspace's reports, and each one runs on their own
        Snowflake credentials. Adding someone here does not grant them access to
        any data their Snowflake role cannot already read.
      </p>
    </section>
  );
}
