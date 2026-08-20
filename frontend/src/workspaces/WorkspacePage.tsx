import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { createDashboard, deleteDashboard, listDashboards } from "../api/dashboards";
import { deleteExplore, listExplores } from "../api/explores";
import { recordView, type ItemType } from "../api/library";
import { createReport, deleteReport, listReports } from "../api/reports";
import type { ReportDefinition, ReportDetail } from "../api/types";
import { FacetChips } from "../library/FacetChips";
import { FavoriteStar } from "../library/FavoriteStar";
import { SearchBar } from "../library/SearchBar";
import {
  ITEM_FILTERS,
  useLibraryQuery,
  type ItemFilter,
} from "../library/useLibraryQuery";
import {
  nextSort,
  sortRows,
  useTableColumns,
  type SortKey,
  type SortState,
} from "../library/useTableColumns";
import ImportPanel from "../reports/ImportPanel";
import MembersPanel from "./MembersPanel";
import { useWorkspaces } from "./useWorkspaces";
import ContextMenu, { useContextMenu, type MenuItem } from "../ui/ContextMenu";
import Icon from "../ui/Icon";
import { exactTime, relativeTime } from "../ui/relativeTime";
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
  workspaceName: string;
  createdBy: string;
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

/** The columns, in order. `key` is both the CSS class suffix and the
 *  width's storage key; `sort` marks the ones a header click orders by.
 *
 *  Hiding on a narrow screen is done from this key in CSS, on the `col`
 *  AND on the cells. It used to be done by nth-child, which was written
 *  when the table had six columns -- adding Type shifted every index and
 *  the header quietly drifted one column out of step with the body. */
const COLUMNS: {
  key: string;
  label: string;
  sort?: SortKey;
  /** Header text is hidden but still announced. */
  quiet?: boolean;
  resizable?: boolean;
}[] = [
  { key: "pin", label: "Pinned", quiet: true },
  { key: "glyph", label: "", quiet: true },
  { key: "name", label: "Name", sort: "name", resizable: true },
  { key: "kind", label: "Type", sort: "kind", resizable: true },
  { key: "detail", label: "Semantic view", sort: "detail", resizable: true },
  { key: "workspace", label: "Workspace", sort: "workspace", resizable: true },
  { key: "creator", label: "Created by", sort: "creator", resizable: true },
  { key: "role", label: "Your role", sort: "role", resizable: true },
  { key: "updated", label: "Modified", sort: "updated", resizable: true },
  { key: "actions", label: "Actions", quiet: true },
];

const ARROW: Record<"asc" | "desc", string> = { asc: "▲", desc: "▼" };

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
  // Browse spans EVERY workspace unless the URL names one. The rail's
  // flyout names one; the rail's Browse does not -- which is the
  // difference between "what is in this workspace" and "where is that
  // thing I remember".
  const [searchParams, setSearchParams] = useSearchParams();
  const workspaceId = searchParams.get("workspace");
  const [showMembers, setShowMembers] = useState(false);

  const workspaces = useWorkspaces();
  const rows = workspaces.data?.workspaces ?? [];
  const selectedId = workspaceId ?? "";
  const selected = rows.find((w) => w.id === selectedId);
  //: Across all workspaces there is no single one to create in, so the
  //: Create menu asks you to pick one first rather than guessing.
  const canCreateHere = selected ? atLeast(selected.myRole, "editor") : false;
  const scope = selectedId || undefined;

  const browse = useLibraryQuery();
  // The kind lives in the URL beside the workspace, so "show me the
  // dashboards" is a link somebody can be sent -- which is what Home's
  // own Dashboards and Reports entries are.
  const kind = (searchParams.get("kind") ?? "all") as ItemFilter;
  const setKind = (next: ItemFilter) => {
    const params: Record<string, string> = {};
    if (selectedId) params.workspace = selectedId;
    if (next !== "all") params.kind = next;
    setSearchParams(params);
  };
  // Ordering is done here rather than by the server: three lists are being
  // merged, so only one of the three could have been ordered remotely.
  // That also means a sort costs no refetch.
  const [sort, setSort] = useState<SortState>({ key: "recent", direction: "desc" });
  const columns = useTableColumns("semanticui.workspace.columns");
  const wants = (want: ItemType) => kind === "all" || kind === want;
  // Enabled once the workspace list has answered -- not once one is
  // CHOSEN. Waiting for a choice is what used to make Browse blank until
  // a personal workspace was found for it.
  const enabled = !workspaces.isLoading;

  const reports = useQuery({
    queryKey: ["reports", selectedId, browse.params],
    queryFn: () => listReports(scope, browse.params),
    enabled: enabled && wants("report"),
    placeholderData: (previous) => previous,
  });

  const dashboards = useQuery({
    queryKey: ["dashboards", selectedId],
    queryFn: () => listDashboards(scope),
    enabled: enabled && wants("dashboard"),
    placeholderData: (previous) => previous,
  });

  const explores = useQuery({
    queryKey: ["explores", selectedId, browse.params],
    queryFn: () => listExplores(scope, browse.params),
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
          workspaceName: report.workspaceName,
          createdBy: report.createdBy ?? "",
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
          workspaceName: dashboard.workspaceName,
          createdBy: dashboard.createdBy ?? "",
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
          workspaceName: explore.workspaceName,
          createdBy: explore.createdBy ?? "",
          favorite: explore.favorite,
          lastViewedAt: explore.lastViewedAt,
          updatedAt: explore.updatedAt,
          href: `/explore?explore=${encodeURIComponent(explore.id)}`,
        });
      }
    }

    return sortRows(out, sort);
    // `wants` closes over browse.kind, which is in the list.
  }, [reports.data, dashboards.data, explores.data, kind, sort]);

  // Any of the three saying it was cut short means the merged list is
  // incomplete, and a list that is silently a fraction of the truth is
  // worse than a slow one.
  const truncated = Boolean(
    (wants("report") && reports.data?.truncated) ||
      (wants("dashboard") && dashboards.data?.truncated) ||
      (wants("explore") && explores.data?.truncated),
  );

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

  // Dispatch on all three kinds explicitly. A two-way `dashboard ? … : …`
  // sent explores to deleteReport, which answers 404 for an id that is not
  // a report -- a delete that looks like a missing item.
  const removeByKind = (item: Item) => {
    if (item.kind === "dashboard") return deleteDashboard(item.id);
    if (item.kind === "explore") return deleteExplore(item.id);
    return deleteReport(item.id);
  };

  const remove = useMutation({
    mutationFn: removeByKind,
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
    const blocked = !selected
      ? "Pick a workspace first — a report has to live in one."
      : canCreateHere
        ? undefined
        : `Your access to ${selected.name} is read-only.`;
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
        disabledReason: blocked,
        // An explore is SAVED from the explorer rather than created empty:
        // there is nothing to open until a query exists. The workspace
        // travels with it, so the thing you build lands where you asked
        // for it rather than in your personal one.
        label: "Explore",
        icon: "compass",
        onSelect: () =>
          navigate(
            selectedId
              ? `/explore?workspace=${encodeURIComponent(selectedId)}`
              : "/explore",
          ),
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
          <h1 className="page-title">{selected?.name ?? "Browse"}</h1>
          <p className="ws-subtitle">
            {selected
              ? selected.kind === "personal"
                ? "Personal workspace"
                : "Shared workspace"
              : `Everything you can open, across ${rows.length} workspace${
                  rows.length === 1 ? "" : "s"
                }`}
          </p>
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
        <label className="library-sort">
          <span className="sr-only">Workspace</span>
          <select
            value={selectedId}
            onChange={(event) => {
              const next = event.target.value;
              const params: Record<string, string> = {};
              if (next) params.workspace = next;
              if (kind !== "all") params.kind = kind;
              setSearchParams(params);
            }}
          >
            <option value="">All workspaces</option>
            {rows.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
        <div className="kind-filter" role="group" aria-label="Show">
          {ITEM_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={kind === filter.value}
              className={kind === filter.value ? "kind-tab on" : "kind-tab"}
              onClick={() => setKind(filter.value)}
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
        {/* The dropdown and the headers drive one piece of state. It keeps
            "Recently opened", which has no column of its own to click. */}
        <label className="library-sort">
          <span className="sr-only">Sort</span>
          <select
            value={sort.key}
            onChange={(event) =>
              setSort((current) => nextSort(current, event.target.value as SortKey))
            }
          >
            <option value="recent">Recently opened</option>
            <option value="updated">Recently changed</option>
            <option value="name">Name</option>
            <option value="kind">Type</option>
            <option value="role">Your role</option>
          </select>
        </label>
      </div>
      <FacetChips
        facets={browse.activeFacets}
        onClear={browse.clearFacet}
        shown={items.length}
        total={items.length}
      />

      {truncated && (
        <p className="tile-hint">
          Showing the first {items.length}. Search, or pick a workspace, to
          narrow it.
        </p>
      )}

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
            {COLUMNS.map((column) => (
              <col
                key={column.key}
                className={`col-${column.key}`}
                // A width the reader chose, as a custom property so the
                // narrow-screen rules can still override it -- an inline
                // `width` would win over every media query and the table
                // would overflow the moment the window narrowed.
                style={
                  columns.widths[column.key]
                    ? ({ "--w": `${columns.widths[column.key]}px` } as React.CSSProperties)
                    : undefined
                }
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th
                  key={column.key}
                  className={`cell-${column.key}`}
                  aria-sort={
                    column.sort && sort.key === column.sort
                      ? sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                >
                  {column.sort ? (
                    <button
                      type="button"
                      className="th-sort"
                      onClick={() =>
                        setSort((current) => nextSort(current, column.sort as SortKey))
                      }
                    >
                      {column.label}
                      <span className="th-sort-arrow" aria-hidden="true">
                        {sort.key === column.sort ? ARROW[sort.direction] : ""}
                      </span>
                    </button>
                  ) : column.quiet ? (
                    <span className="sr-only">{column.label}</span>
                  ) : (
                    column.label
                  )}
                  {column.resizable && (
                    // Its own control, not a bare div: a column width is
                    // adjustable from the keyboard too, and a reader who
                    // cannot drag still gets the reset.
                    <span
                      className="col-grip"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${column.label}`}
                      onPointerDown={(event) =>
                        columns.beginResize(
                          event,
                          column.key,
                          event.currentTarget.parentElement?.getBoundingClientRect().width ??
                            120,
                        )
                      }
                      onDoubleClick={() => columns.reset(column.key)}
                    />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <Fragment key={`${item.kind}:${item.id}`}>
              <tr className={pendingDelete?.id === item.id ? "is-confirming" : undefined}>
                <td className="cell-pin pin-cell">
                  <FavoriteStar
                    itemType={item.kind}
                    id={item.id}
                    favorite={item.favorite}
                    invalidate={`${item.kind}s`}
                  />
                </td>
                <td className="cell-glyph type-glyph" aria-hidden="true">
                  {GLYPH[item.kind]}
                </td>
                <td className="cell-name">
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
                <td className="cell-kind item-kind">{LABEL[item.kind]}</td>
                <td className="cell-detail report-view" title={item.detail}>
                  {item.detail}
                </td>
                <td className="cell-workspace">{item.workspaceName}</td>
                <td className="cell-creator">{item.createdBy || "—"}</td>
                <td className="cell-role">{item.myRole}</td>
                <td
                  className="cell-updated report-updated"
                  title={item.updatedAt ? exactTime(item.updatedAt) : ""}
                >
                  {item.updatedAt ? relativeTime(item.updatedAt) : "—"}
                </td>
                <td className="cell-actions row-actions">
                  {/* An icon, and a red one: "Delete" repeated down every
                      row is the loudest word on the page, and the one
                      action there you least want to invite. Offered for
                      every kind -- this list is the only place an explore
                      can be deleted from. */}
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
                </td>
              </tr>
              {pendingDelete?.id === item.id && (
                // In the row it is about, and as a row of its own so the
                // table's columns still line up underneath it.
                <tr className="confirm-row">
                  <td colSpan={COLUMNS.length}>
                    <span role="group" aria-label="Confirm delete">
                      Delete “{item.name}”? This cannot be undone.
                      <button
                        type="button"
                        className="danger-primary"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(item)}
                      >
                        {remove.isPending ? "Deleting…" : "Delete"}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setPendingDelete(null);
                          setDeleteError(null);
                        }}
                      >
                        Cancel
                      </button>
                      {deleteError && <span role="alert">{deleteError}</span>}
                    </span>
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      </div>

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
