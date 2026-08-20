import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { createDashboard, deleteDashboard, listDashboards } from "../api/dashboards";
import { listExplores } from "../api/explores";
import { recordView, type ItemType } from "../api/library";
import { createReport, deleteReport, listReports } from "../api/reports";
import type { ReportDefinition, ReportDetail } from "../api/types";
import { FacetChips } from "../library/FacetChips";
import { FavoriteStar } from "../library/FavoriteStar";
import { SearchBar } from "../library/SearchBar";
import { ITEM_FILTERS, useLibraryQuery } from "../library/useLibraryQuery";
import ImportPanel from "../reports/ImportPanel";
import MembersPanel from "./MembersPanel";
import { useWorkspaces } from "./useWorkspaces";
import ContextMenu, { useContextMenu, type MenuItem } from "../ui/ContextMenu";
import Icon from "../ui/Icon";
import { atLeast } from "../api/workspaces";

function blankDefinition(name: string): ReportDefinition {
  return {
    // Bumped with the backend. An older document would still be accepted --
    // parse_definition migrates it -- but there is no reason to write one.
    schemaVersion: 3,
    name,
    view: { database: "", schema: "", name: "" },
    canvas: { columns: 12, rowHeight: 40 },
    pages: [{ id: "p1", name: "Page 1", visuals: [], filters: [] }],
    filters: [],
    hierarchies: [],
  };
}

/** One row of the workspace list, whatever kind of thing it is. */
interface Item {
  kind: ItemType;
  id: string;
  name: string;
  /** The semantic view it reads, or the tile count for a dashboard. */
  detail: string;
  myRole: string;
  favorite: boolean;
  lastViewedAt: string | null;
  updatedAt: string;
  href: string;
}

const GLYPH: Record<ItemType, string> = {
  report: "▦",
  dashboard: "▩",
  explore: "◈",
};

const LABEL: Record<ItemType, string> = {
  report: "Report",
  dashboard: "Dashboard",
  explore: "Explore",
};

/**
 * Everything in one workspace: reports, dashboards and saved explores.
 *
 * One list with a kind filter rather than a menu each. All three live in a
 * workspace, are governed by the same membership, and are browsed the same
 * way -- so what separates them is a control on this page, not three pages
 * that would each have to grow search, pinning and sorting of their own.
 */
export default function WorkspacePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pendingDelete, setPendingDelete] = useState<Item | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  // Selection lives in the URL and is set from the rail's workspaces
  // flyout. There is no switcher on this page: you chose a workspace to
  // get here, and a second control to choose again is the same decision
  // asked twice.
  const [searchParams] = useSearchParams();
  const workspaceId = searchParams.get("workspace");
  const [showMembers, setShowMembers] = useState(false);

  const workspaces = useWorkspaces();
  const rows = workspaces.data?.workspaces ?? [];
  // Default to the personal workspace once the list arrives, so the page is
  // never showing "all workspaces" with a switcher that claims otherwise.
  const selectedId = workspaceId ?? rows.find((w) => w.kind === "personal")?.id ?? "";
  const selected = rows.find((w) => w.id === selectedId);
  const canCreateHere = selected ? atLeast(selected.myRole, "editor") : false;

  const browse = useLibraryQuery();
  const wants = (kind: ItemType) => browse.kind === "all" || browse.kind === kind;
  const enabled = Boolean(selectedId);

  const reports = useQuery({
    queryKey: ["reports", selectedId, browse.params],
    queryFn: () => listReports(selectedId, browse.params),
    enabled: enabled && wants("report"),
    placeholderData: (previous) => previous,
  });

  const dashboards = useQuery({
    queryKey: ["dashboards", selectedId],
    queryFn: () => listDashboards(selectedId),
    enabled: enabled && wants("dashboard"),
    placeholderData: (previous) => previous,
  });

  const explores = useQuery({
    queryKey: ["explores", selectedId, browse.params],
    queryFn: () => listExplores(selectedId, browse.params),
    enabled: enabled && wants("explore"),
    placeholderData: (previous) => previous,
  });

  // Merged and re-sorted here rather than on the server: each list is
  // already filtered by the same browse params, so only the final ordering
  // has to be redone once the three are one.
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    if (wants("report")) {
      for (const report of reports.data?.reports ?? []) {
        out.push({
          kind: "report",
          id: report.id,
          name: report.name,
          detail: report.view.database
            ? `${report.view.database}.${report.view.schema}.${report.view.name}`
            : "—",
          myRole: report.myRole,
          favorite: report.favorite,
          lastViewedAt: report.lastViewedAt,
          updatedAt: report.updatedAt,
          href: `/reports/${report.id}`,
        });
      }
    }
    if (wants("dashboard")) {
      for (const dashboard of dashboards.data?.dashboards ?? []) {
        out.push({
          kind: "dashboard",
          id: dashboard.id,
          name: dashboard.name,
          detail: `${dashboard.tileCount} tile${dashboard.tileCount === 1 ? "" : "s"}`,
          myRole: dashboard.myRole,
          favorite: dashboard.favorite ?? false,
          lastViewedAt: dashboard.lastViewedAt ?? null,
          updatedAt: dashboard.updatedAt ?? "",
          href: `/dashboards/${dashboard.id}`,
        });
      }
    }
    if (wants("explore")) {
      for (const explore of explores.data?.explores ?? []) {
        out.push({
          kind: "explore",
          id: explore.id,
          name: explore.name,
          detail: explore.view.database
            ? `${explore.view.database}.${explore.view.schema}.${explore.view.name}`
            : "—",
          myRole: explore.myRole,
          favorite: explore.favorite,
          lastViewedAt: explore.lastViewedAt,
          updatedAt: explore.updatedAt,
          href: `/explore?explore=${encodeURIComponent(explore.id)}`,
        });
      }
    }

    const sort = browse.params.sort ?? "recent";
    return out.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      const key = sort === "recent" ? "lastViewedAt" : "updatedAt";
      // Never opened sorts last rather than first: an empty string would
      // otherwise beat every real timestamp.
      return (b[key] ?? "").localeCompare(a[key] ?? "");
    });
    // `wants` closes over browse.kind, which is in the list.
  }, [reports.data, dashboards.data, explores.data, browse.kind, browse.params.sort]);

  const loading =
    (wants("report") && reports.isLoading) ||
    (wants("dashboard") && dashboards.isLoading) ||
    (wants("explore") && explores.isLoading);
  const error = reports.error ?? dashboards.error ?? explores.error;
  const filtering = browse.activeFacets.length > 0;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["reports"] });
    queryClient.invalidateQueries({ queryKey: ["dashboards"] });
    queryClient.invalidateQueries({ queryKey: ["explores"] });
    queryClient.invalidateQueries({ queryKey: ["home"] });
  };

  const remove = useMutation({
    mutationFn: (item: Item) =>
      item.kind === "dashboard" ? deleteDashboard(item.id) : deleteReport(item.id),
    onSuccess: () => {
      setPendingDelete(null);
      setDeleteError(null);
      invalidate();
    },
    // A failed delete must not leave the confirm dialog open with no
    // feedback -- the user needs to know it didn't happen.
    onError: (failure) => {
      setDeleteError(
        failure instanceof ApiError ? failure.message : "Could not delete this item.",
      );
    },
  });

  const [createError, setCreateError] = useState<string | null>(null);
  const create = useContextMenu();
  const createButton = useRef<HTMLButtonElement>(null);

  const createTheReport = useMutation({
    mutationFn: () =>
      createReport(blankDefinition("Untitled report"), selectedId || undefined),
    onSuccess: (report) => navigate(`/reports/${report.id}`),
    onError: (failure) =>
      setCreateError(
        failure instanceof ApiError ? failure.message : "Could not create a new report.",
      ),
  });

  const createTheDashboard = useMutation({
    mutationFn: () => createDashboard("Untitled dashboard", selectedId || undefined),
    onSuccess: (dashboard) => navigate(`/dashboards/${dashboard.id}`),
    onError: (failure) =>
      setCreateError(
        failure instanceof ApiError ? failure.message : "Could not create a dashboard.",
      ),
  });

  const creating = createTheReport.isPending || createTheDashboard.isPending;

  /** What "Create" offers. Read-only in this workspace disables the two
   *  that write to it, with the reason attached -- an action that vanishes
   *  reads as a bug, one that says why does not. */
  const createItems = (): MenuItem[] => {
    const blocked = canCreateHere
      ? undefined
      : `Your access to ${selected?.name ?? "this workspace"} is read-only.`;
    return [
      {
        id: "report",
        label: "Report",
        icon: "report",
        disabledReason: blocked,
        onSelect: () => {
          setCreateError(null);
          createTheReport.mutate();
        },
      },
      {
        id: "dashboard",
        label: "Dashboard",
        icon: "dashboard",
        disabledReason: blocked,
        onSelect: () => {
          setCreateError(null);
          createTheDashboard.mutate();
        },
      },
      {
        id: "explore",
        // An explore is SAVED from the explorer rather than created empty:
        // there is nothing to open until a query exists.
        label: "Explore",
        icon: "compass",
        onSelect: () => navigate("/explore"),
      },
      {
        id: "import",
        label: "Import a report…",
        icon: "upload",
        separatorBefore: true,
        onSelect: () => setShowImport(true),
      },
    ];
  };

  function onImported(report: ReportDetail) {
    setShowImport(false);
    navigate(`/reports/${report.id}`);
  }

  return (
    <main className="reports">
      <header className="reports-head">
        <div className="ws-title">
          <h1 className="page-title">{selected?.name ?? "Workspace"}</h1>
          {selected && (
            <p className="ws-subtitle">
              {selected.kind === "personal" ? "Personal workspace" : "Shared workspace"}
            </p>
          )}
        </div>
        <div className="reports-actions">
          {/* A personal workspace has no membership to manage -- that is
              what makes it personal -- so the control is absent rather
              than disabled. */}
          {selected?.kind === "shared" && (
            <button
              type="button"
              className="cmd"
              onClick={() => setShowMembers(true)}
            >
              <Icon name="grid" />
              Members ({selected.memberCount})
            </button>
          )}
          {/* One button, four things to make. Four buttons in a row makes
              the reader choose before they have been told what the choices
              are; a menu tells them first. */}
          <button
            ref={createButton}
            type="button"
            className="cmd-primary"
            aria-haspopup="menu"
            aria-expanded={Boolean(create.at)}
            disabled={creating}
            onClick={() => create.openUnder(createButton.current)}
          >
            <Icon name="plus" />
            {creating ? "Creating…" : "Create"}
            <span aria-hidden="true">▾</span>
          </button>
        </div>
      </header>

      {selected && !canCreateHere && (
        <p className="tile-hint">
          Your access to {selected.name} is read-only. New items can be created in a
          workspace you can edit.
        </p>
      )}
      {createError && <p role="alert">{createError}</p>}

      <div className="library-bar">
        <SearchBar
          value={browse.params.q ?? ""}
          onChange={browse.setSearch}
          placeholder="Search by name, view or workspace"
        />
        {/* One filter instead of a menu per kind. */}
        <div className="kind-filter" role="group" aria-label="Show">
          {ITEM_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={browse.kind === filter.value}
              className={browse.kind === filter.value ? "kind-tab on" : "kind-tab"}
              onClick={() => browse.setKind(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={browse.params.favorite ? "toggle-button on" : "toggle-button"}
          aria-pressed={browse.params.favorite ?? false}
          onClick={browse.toggleFavoriteFilter}
        >
          <span aria-hidden="true">★</span> Pinned
        </button>
        <label className="library-sort">
          <span className="sr-only">Sort</span>
          <select
            value={browse.params.sort ?? "recent"}
            onChange={(event) =>
              browse.setSort(event.target.value as "recent" | "name" | "updated")
            }
          >
            <option value="recent">Recently opened</option>
            <option value="updated">Recently changed</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>
      <FacetChips
        facets={browse.activeFacets}
        onClear={browse.clearFacet}
        shown={items.length}
        total={items.length}
      />

      <div className="library-results">
      {loading && <p>Loading…</p>}
      {error && (
        <p role="alert">
          {error instanceof ApiError ? error.message : "Could not load this workspace."}
        </p>
      )}

      {/* Two different emptinesses. "Nothing here yet" is a dead end that
          wants a first item; "nothing matched" is a filter the user can
          undo, and saying so beats a blank panel. */}
      {!loading && items.length === 0 && !filtering && (
        <p className="empty">Nothing here yet. Create a report or a dashboard.</p>
      )}
      {!loading && items.length === 0 && filtering && (
        <div className="empty">
          <p>
            Nothing matches
            {browse.params.q?.trim() ? ` “${browse.params.q.trim()}”` : " those filters"}.
          </p>
          {/* "Clear filters", not "Clear search": it drops every facet, and
              the search box already owns the words "Clear search". */}
          <button type="button" className="secondary" onClick={browse.clearAll}>
            Clear filters
          </button>
        </div>
      )}

      {items.length > 0 && (
        <table className="content-table">
          <colgroup>
            <col className="col-pin" />
            <col className="col-glyph" />
            <col />
            <col className="col-kind" />
            <col className="col-detail" />
            <col className="col-role" />
            <col className="col-updated" />
            <col className="col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>
                <span className="sr-only">Pinned</span>
              </th>
              <th aria-hidden="true"></th>
              <th>Name</th>
              <th>Type</th>
              <th>Semantic view</th>
              <th>Your role</th>
              <th>Modified</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={`${item.kind}:${item.id}`}>
                <td className="pin-cell">
                  <FavoriteStar
                    itemType={item.kind}
                    id={item.id}
                    favorite={item.favorite}
                    invalidate={`${item.kind}s`}
                  />
                </td>
                <td className="type-glyph" aria-hidden="true">
                  {GLYPH[item.kind]}
                </td>
                <td>
                  <Link
                    className="report-name"
                    to={item.href}
                    // Recorded on the way out, not on arrival: this list is
                    // where "recently opened" is read, and a failed record
                    // must never block the navigation.
                    onClick={() => {
                      void recordView(item.kind, item.id).catch(() => {});
                    }}
                  >
                    {item.name}
                  </Link>
                </td>
                <td className="item-kind">{LABEL[item.kind]}</td>
                <td className="report-view">{item.detail}</td>
                <td>{item.myRole}</td>
                <td className="report-updated">
                  {item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "—"}
                </td>
                <td className="row-actions">
                  {/* An icon, and a red one: "Delete" repeated down every
                      row is the loudest word on the page, and the one
                      action there you least want to invite. An explore is
                      deleted from the explorer that owns it. */}
                  {item.kind !== "explore" && (
                    <button
                      className="icon-button danger"
                      aria-label={`Delete ${item.name}`}
                      title={`Delete ${item.name}`}
                      onClick={() => {
                        setPendingDelete(item);
                        setDeleteError(null);
                      }}
                    >
                      <span aria-hidden="true">🗑</span>
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      </div>

      {pendingDelete && (
        <div className="confirm" role="dialog" aria-label="Confirm delete">
          <p>Delete “{pendingDelete.name}”? This cannot be undone.</p>
          {deleteError && <p role="alert">{deleteError}</p>}
          <button
            onClick={() => remove.mutate(pendingDelete)}
            disabled={remove.isPending}
          >
            {remove.isPending ? "Deleting..." : "Delete"}
          </button>
          <button
            className="secondary"
            onClick={() => {
              setPendingDelete(null);
              setDeleteError(null);
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {create.at && (
        <ContextMenu at={create.at} items={createItems()} onClose={create.close} />
      )}

      {showImport && (
        <div className="panel-overlay">
          <ImportPanel onImported={onImported} onClose={() => setShowImport(false)} />
        </div>
      )}
      {showMembers && selected && (
        <div className="panel-overlay">
          <MembersPanel
            workspaceId={selected.id}
            myRole={selected.myRole}
            onClose={() => setShowMembers(false)}
          />
        </div>
      )}
    </main>
  );
}
