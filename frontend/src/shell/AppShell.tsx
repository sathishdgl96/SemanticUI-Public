import { useBranding } from "./useBranding";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client";
import { useMe } from "../auth/useMe";
import { ProfileMenu } from "../session/ProfileMenu";
import WorkspacesFlyout from "./WorkspacesFlyout";
import { prefetchRoute, type RouteKey } from "../routes";
import { amIAppAdmin } from "../api/admin";
import Icon from "../ui/Icon";
import AnnouncementBanner from "../announcements/AnnouncementBanner";

/** The PowerBI-style frame every authenticated page sits in: near-black top
 *  bar with the brand mark and identity, and the left nav rail with the
 *  workspaces flyout. */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const branding = useBranding();
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  // Asked of everyone, and answered for everyone: the endpoint is not
  // behind the admin gate, so an ordinary page load does not produce an
  // audited denial just to decide whether to draw a nav item.
  const admin = useQuery({
    queryKey: ["admin", "whoami"],
    queryFn: amIAppAdmin,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const location = useLocation();

  // The flyout is a way of GETTING somewhere, so arriving anywhere ends it.
  // Without this it stayed open over the page it had just navigated to --
  // and over every page reached from the rail afterwards.
  useEffect(() => {
    setWorkspacesOpen(false);
  }, [location.pathname, location.search]);

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

  /** Hover and focus both start the route's chunk downloading. The pointer
   *  crossing the rail, or a tab stop landing on it, is the only warning we
   *  get before the click -- and it is usually enough to have the page in
   *  memory by the time it arrives, so nothing suspends and no loading
   *  screen appears. Repeats are free: import() is memoised. */
  const warm = (key: RouteKey) => ({
    onPointerEnter: () => prefetchRoute(key),
    onFocus: () => prefetchRoute(key),
  });

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
          <NavLink
            to="/"
            className="rail-item"
            title="Home"
            end
            {...warm("home")}
            onClick={() => setWorkspacesOpen(false)}
          >
            <span className="rail-glyph" aria-hidden="true">
              ⌂
            </span>
            <span className="rail-label">Home</span>
          </NavLink>
          {/* Browse and "a workspace" are the same route with and without
              a ?workspace=. Marking Browse current while you are inside one
              said you were somewhere you were not. */}
          <NavLink
            to="/reports"
            className={({ isActive }) =>
              isActive && !location.search.includes("workspace=")
                ? "rail-item active"
                : "rail-item"
            }
            title="Browse"
            {...warm("reports")}
            onClick={() => setWorkspacesOpen(false)}
          >
            <span className="rail-glyph" aria-hidden="true">
              ▤
            </span>
            <span className="rail-label">Browse</span>
          </NavLink>
          <NavLink
            to="/explore"
            className="rail-item"
            title="Explore"
            {...warm("explore")}
            onClick={() => setWorkspacesOpen(false)}
          >
            <span className="rail-glyph" aria-hidden="true">
              ◈
            </span>
            <span className="rail-label">Explore</span>
          </NavLink>
          <button
            type="button"
            className={
              location.search.includes("workspace=")
                ? "rail-item active"
                : "rail-item"
            }
            aria-expanded={workspacesOpen}
            onClick={() => setWorkspacesOpen((open) => !open)}
            title="Workspaces"
          >
            <span className="rail-glyph" aria-hidden="true">
              ▦
            </span>
            <span className="rail-label">Workspaces</span>
          </button>
          {/* Absent rather than disabled for everyone else: a control that
              is visible and refuses is an invitation to try. */}
          {admin.data?.isAppAdmin && (
            <NavLink
              to="/admin"
              className="rail-item rail-admin"
              title="Administration"
              {...warm("admin")}
              onClick={() => setWorkspacesOpen(false)}
            >
              <span className="rail-glyph" aria-hidden="true">
                <Icon name="shield" size={19} />
              </span>
              <span className="rail-label">Admin</span>
            </NavLink>
          )}
        </nav>
        {workspacesOpen && <WorkspacesFlyout onClose={() => setWorkspacesOpen(false)} />}
        {/* Above the page rather than on it: a notice you have to be on
            Home to see is a notice most people miss. */}
        <main className="app-content">
          <AnnouncementBanner />
          {children}
        </main>
      </div>
    </div>
  );
}
