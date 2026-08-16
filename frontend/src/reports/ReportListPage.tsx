import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { createReport, deleteReport, listReports } from "../api/reports";
import type { ReportDefinition, ReportDetail } from "../api/types";
import ImportPanel from "./ImportPanel";
import MembersPanel from "../workspaces/MembersPanel";
import WorkspaceSwitcher from "../workspaces/WorkspaceSwitcher";
import { useWorkspaces } from "../workspaces/useWorkspaces";
import { atLeast } from "../api/workspaces";

function blankDefinition(name: string): ReportDefinition {
  return {
    // Bumped with the backend. A v1 document would still be accepted --
    // parse_definition migrates it -- but there is no reason to write one.
    schemaVersion: 2,
    name,
    view: { database: "", schema: "", name: "" },
    canvas: { columns: 12, rowHeight: 40 },
    visuals: [],
    filters: [],
    hierarchies: [],
  };
}

export default function ReportListPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  // Selection lives in the URL, so the rail's workspaces flyout and this
  // page share one source of truth and a workspace view is linkable.
  const [searchParams, setSearchParams] = useSearchParams();
  const workspaceId = searchParams.get("workspace");
  const setWorkspaceId = (id: string) => setSearchParams({ workspace: id });
  const [showMembers, setShowMembers] = useState(false);

  const workspaces = useWorkspaces();
  const rows = workspaces.data?.workspaces ?? [];
  // Default to the personal workspace once the list arrives, so the page is
  // never showing "all workspaces" with a switcher that claims otherwise.
  const selectedId = workspaceId ?? rows.find((w) => w.kind === "personal")?.id ?? "";
  const selected = rows.find((w) => w.id === selectedId);
  const canCreateHere = selected ? atLeast(selected.myRole, "editor") : false;

  const reports = useQuery({
    // Keyed on the workspace: switching must refetch rather than serve the
    // previous workspace's list.
    queryKey: ["reports", selectedId],
    // Wrapped, not passed by reference: TanStack calls queryFn with its own
    // context object, which would otherwise arrive as the workspaceId.
    queryFn: () => listReports(selectedId || undefined),
    enabled: Boolean(selectedId),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteReport(id),
    onSuccess: () => {
      setPendingDelete(null);
      setDeleteError(null);
      queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
    // A failed delete must not leave the confirm dialog open with no
    // feedback — the user needs to know it didn't happen and get a way to
    // retry or back out, not just watch a "Delete" click silently do nothing.
    onError: (error) => {
      setDeleteError(
        error instanceof ApiError ? error.message : "Could not delete this report.",
      );
    },
  });

  const [createError, setCreateError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createReport(blankDefinition("Untitled report"), selectedId || undefined),
    onSuccess: (report) => navigate(`/reports/${report.id}`),
    // Without this, a rejected create silently does nothing: no report, no
    // navigation, no feedback -- clicking "New report" would look broken.
    onError: (error) => {
      setCreateError(
        error instanceof ApiError ? error.message : "Could not create a new report.",
      );
    },
  });

  function onImported(report: ReportDetail) {
    setShowImport(false);
    navigate(`/reports/${report.id}`);
  }

  return (
    <main className="reports">
      <header className="reports-head">
        <div className="ws-title">
          <h1 className="page-title">{selected?.name ?? "Reports"}</h1>
          {selected && (
            <p className="ws-subtitle">
              {selected.kind === "personal" ? "Personal workspace" : "Shared workspace"}
              {" · "}You are {selected.myRole === "admin" ? "an" : "a"} {selected.myRole}{" "}
              here
            </p>
          )}
        </div>
        <WorkspaceSwitcher
          value={selectedId}
          onChange={setWorkspaceId}
          onCreated={setWorkspaceId}
          onManageMembers={() => setShowMembers(true)}
        />
        <div className="reports-actions">
          <Link className="button secondary" to="/explore">
            Explore
          </Link>
          <button className="secondary" onClick={() => setShowImport(true)}>
            Import
          </button>
          <button
            onClick={() => {
              setCreateError(null);
              create.mutate();
            }}
            disabled={create.isPending || !canCreateHere}
          >
            {create.isPending ? "Creating..." : "New report"}
          </button>
        </div>
      </header>

      {selected && !canCreateHere && (
        <p className="tile-hint">
          You are a {selected.myRole} in {selected.name}, so you cannot add reports
          here. Switch to a workspace you can write to.
        </p>
      )}
      {createError && <p role="alert">{createError}</p>}
      {reports.isLoading && <p>Loading reports...</p>}
      {reports.isError && (
        <p role="alert">
          {reports.error instanceof ApiError
            ? reports.error.message
            : "Could not load your reports."}
        </p>
      )}
      {reports.data?.reports.length === 0 && (
        <p className="empty">No reports yet. Create one to get started.</p>
      )}

      {reports.data && reports.data.reports.length > 0 && (
        <table className="content-table">
          <thead>
            <tr>
              <th aria-hidden="true"></th>
              <th>Name</th>
              <th>Semantic view</th>
              <th>Your role</th>
              <th>Modified</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {reports.data.reports.map((report) => (
              <tr key={report.id}>
                <td className="type-glyph" aria-hidden="true">
                  ▦
                </td>
                <td>
                  <Link className="report-name" to={`/reports/${report.id}`}>
                    {report.name}
                  </Link>
                </td>
                <td className="report-view">
                  {report.view.database
                    ? `${report.view.database}.${report.view.schema}.${report.view.name}`
                    : "—"}
                </td>
                <td>{report.myRole}</td>
                <td className="report-updated">
                  {new Date(report.updatedAt).toLocaleString()}
                </td>
                <td className="row-actions">
                  <button
                    className="link"
                    aria-label={`Delete ${report.name}`}
                    onClick={() => {
                      setPendingDelete(report.id);
                      setDeleteError(null);
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pendingDelete && (
        <div className="confirm" role="dialog" aria-label="Confirm delete">
          <p>Delete this report? This cannot be undone.</p>
          {deleteError && <p role="alert">{deleteError}</p>}
          <button onClick={() => remove.mutate(pendingDelete)} disabled={remove.isPending}>
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
