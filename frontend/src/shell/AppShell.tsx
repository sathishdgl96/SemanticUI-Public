import { useBranding } from "./useBranding";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client";
import { useMe } from "../auth/useMe";
import { ProfileMenu } from "../session/ProfileMenu";
import WorkspacesFlyout from "./WorkspacesFlyout";

/** The PowerBI-style frame every authenticated page sits in: near-black top
 *  bar with the brand mark and identity, and the left nav rail with the
 *  workspaces flyout. */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const branding = useBranding();
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [workspacesOpen, setWorkspacesOpen] = useState(false);

  async function logout() {
    // The server-side session is over the moment the user asks, regardless of
    // whether the request below succeeds -- a network hiccup must not strand
    // another identity's cached data in this browser. Clear the cache BEFORE
    // navigating; this ordering was a security fix, do not reorder.
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {
      // Local logout proceeds regardless; the server may already have dropped
      // the session, or the failure is transient and irrelevant now.
    } finally {
      queryClient.clear();
      navigate("/login");
    }
  }

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <span className="brand">
          {branding.logoUrl ? (
            <img
              className="brand-logo"
              src={branding.logoUrl}
              alt=""
              onError={(e) => {
                // A dead logo URL must not render as a broken-image icon;
                // hiding it leaves the name to carry the brand.
                e.currentTarget.style.display = "none";
              }}
            />
          ) : (
            <span className="brand-mark" aria-hidden="true" />
          )}
          {branding.name}
        </span>
        <span className="topbar-right">
          {me.data ? (
            <ProfileMenu
              user={me.data.snowflakeUser}
              account={me.data.snowflakeAccount}
            />
          ) : (
            <span className="identity" />
          )}
          <button type="button" className="link topbar-link" onClick={logout}>
            Log out
          </button>
        </span>
      </header>
      <div className="app-body">
        <nav className="nav-rail" aria-label="Main">
          <NavLink to="/reports" className="rail-item" title="Home" end>
            <span className="rail-glyph" aria-hidden="true">
              ⌂
            </span>
            <span className="rail-label">Home</span>
          </NavLink>
          <NavLink to="/explore" className="rail-item" title="Explore">
            <span className="rail-glyph" aria-hidden="true">
              ◈
            </span>
            <span className="rail-label">Explore</span>
          </NavLink>
          <button
            type="button"
            className="rail-item"
            aria-expanded={workspacesOpen}
            onClick={() => setWorkspacesOpen((open) => !open)}
            title="Workspaces"
          >
            <span className="rail-glyph" aria-hidden="true">
              ▦
            </span>
            <span className="rail-label">Workspaces</span>
          </button>
        </nav>
        {workspacesOpen && <WorkspacesFlyout onClose={() => setWorkspacesOpen(false)} />}
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
