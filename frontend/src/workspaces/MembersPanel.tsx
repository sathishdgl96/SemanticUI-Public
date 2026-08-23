import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ApiError } from "../api/client";
import type { Role } from "../api/types";
import { addMember, listMembers, removeMember, setMemberRole } from "../api/workspaces";
import CloseButton from "../ui/CloseButton";
import Icon from "../ui/Icon";

const ROLE_OPTIONS: Role[] = ["viewer", "editor", "admin"];

/** What each role actually lets someone do, in the app's own terms rather
 *  than the word alone. A dropdown of three nouns tells you nothing. */
const ROLE_MEANING: Record<Role, string> = {
  viewer: "Can open everything here",
  editor: "Can create and change",
  admin: "Can also manage members",
};

interface Props {
  workspaceId: string;
  myRole: Role;
  onClose: () => void;
}

/** Two letters from a Snowflake username, for the row's avatar. Initials
 *  rather than a picture: there is no profile image anywhere in this app,
 *  and a grey circle with a silhouette says less than "SN". */
function initials(name: string): string {
  const parts = name.split(/[._\-\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export default function MembersPanel({ workspaceId, myRole, onClose }: Props) {
  const queryClient = useQueryClient();
  const members = useQuery({
    queryKey: ["workspace-members", workspaceId],
    queryFn: () => listMembers(workspaceId),
  });
  const [username, setUsername] = useState("");
  const [newRole, setNewRole] = useState<Role>("viewer");
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  // Explicit ids, not wrapping labels: a <label> around a <select> folds the
  // option text into the control's accessible name, so it reads as
  // "Role for BOBviewereditoradmin" in a real browser.
  const usernameId = useId();
  const newRoleId = useId();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["workspace-members", workspaceId] });
    // Membership changes the member count the header shows.
    queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    // And it can change what the caller may see, if they removed themselves
    // from a workspace they were reading.
    queryClient.invalidateQueries({ queryKey: ["reports"] });
    queryClient.invalidateQueries({ queryKey: ["dashboards"] });
    queryClient.invalidateQueries({ queryKey: ["explores"] });
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
    onSuccess: () => {
      setPendingRemove(null);
      refresh();
    },
  });

  const rows = members.data?.members ?? [];
  const admins = rows.filter((m) => m.role === "admin").length;
  const canManage = myRole === "admin";
  const failure = add.error ?? changeRole.error ?? remove.error;

  return (
    <section className="panel members-panel" aria-label="Workspace members">
      <header className="panel-head">
        <div>
          <h3>Members</h3>
          <p className="panel-subtitle">
            {rows.length} {rows.length === 1 ? "person" : "people"} can open this
            workspace
          </p>
        </div>
        <CloseButton onClick={onClose} />
      </header>

      {members.isLoading && <p className="tile-hint">Loading members…</p>}
      {members.isError && <p role="alert">Could not load members.</p>}

      <ul className="member-list">
        {rows.map((member) => {
          // The server refuses to remove or demote the last admin. Disabling
          // with a stated reason beats letting someone try and be rejected.
          const isLastAdmin = member.role === "admin" && admins === 1;
          const blocked = isLastAdmin
            ? "The last admin cannot be removed or demoted. Promote someone else first."
            : undefined;
          return (
            <li key={member.userId} className="member-row">
              <span className="member-avatar" aria-hidden="true">
                {initials(member.snowflakeUser)}
              </span>
              <span className="member-identity">
                <span className="member-name">
                  {member.snowflakeUser}
                  {member.isMe && <span className="member-you">You</span>}
                </span>
                <span className="member-meaning">{ROLE_MEANING[member.role]}</span>
              </span>

              {canManage ? (
                <span className="member-controls">
                  <label className="sr-only" htmlFor={`role-${member.userId}`}>
                    Role for {member.snowflakeUser}
                  </label>
                  <select
                    id={`role-${member.userId}`}
                    value={member.role}
                    disabled={isLastAdmin || changeRole.isPending}
                    title={blocked}
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
                    className="icon-button danger"
                    aria-label={`Remove ${member.snowflakeUser}`}
                    title={blocked ?? `Remove ${member.snowflakeUser}`}
                    disabled={isLastAdmin}
                    onClick={() => setPendingRemove(member.userId)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </span>
              ) : (
                <span className={`role-pill role-${member.role}`}>{member.role}</span>
              )}

              {pendingRemove === member.userId && (
                <span className="member-confirm" role="group" aria-label="Confirm remove">
                  Remove {member.snowflakeUser} from this workspace?
                  <button
                    type="button"
                    className="danger-primary"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(member.userId)}
                  >
                    {remove.isPending ? "Removing…" : "Remove"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setPendingRemove(null)}
                  >
                    Cancel
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {canManage ? (
        <form
          className="member-add"
          aria-label="Add someone"
          onSubmit={(e) => {
            e.preventDefault();
            if (username.trim()) add.mutate();
          }}
        >
          <h4 className="member-add-title">Add someone</h4>
          <div className="member-add-row">
            <span className="field">
              <label htmlFor={usernameId}>Snowflake username</label>
              <input
                id={usernameId}
                value={username}
                placeholder="e.g. A_SMITH"
                onChange={(e) => setUsername(e.target.value)}
              />
            </span>
            <span className="field">
              <label htmlFor={newRoleId}>Role</label>
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
            </span>
            <button type="submit" disabled={!username.trim() || add.isPending}>
              {add.isPending ? "Adding…" : "Add"}
            </button>
          </div>
          <p className="tile-hint">{ROLE_MEANING[newRole]}.</p>
        </form>
      ) : (
        <p className="tile-hint">Only an admin can change who is in this workspace.</p>
      )}

      {failure && (
        <p role="alert">
          {failure instanceof ApiError ? failure.message : "That did not work."}
        </p>
      )}

      <p className="member-note">
        Every member runs queries on their own Snowflake credentials. Adding
        someone here does not grant them access to any data their Snowflake role
        cannot already read.
      </p>
    </section>
  );
}
