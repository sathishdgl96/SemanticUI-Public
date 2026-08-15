import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { createReport, deleteReport, listReports } from "../api/reports";
import type { ReportDefinition } from "../api/types";

function blankDefinition(name: string): ReportDefinition {
  return {
    schemaVersion: 1,
    name,
    view: { database: "", schema: "", name: "" },
    canvas: { columns: 12, rowHeight: 40 },
    visuals: [],
  };
}

export default function ReportListPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reports = useQuery({ queryKey: ["reports"], queryFn: listReports });

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

  const create = useMutation({
    mutationFn: () => createReport(blankDefinition("Untitled report")),
    onSuccess: (report) => navigate(`/reports/${report.id}`),
  });

  return (
    <main className="reports">
      <header className="reports-head">
        <h1>Reports</h1>
        <div className="reports-actions">
          <Link className="button secondary" to="/explore">
            Explore
          </Link>
          <button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? "Creating..." : "New report"}
          </button>
        </div>
      </header>

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
        <ul className="report-list">
          {reports.data.reports.map((report) => (
            <li key={report.id}>
              <Link className="report-name" to={`/reports/${report.id}`}>
                {report.name}
              </Link>
              <span className="report-view">
                {`${report.view.database}.${report.view.schema}.${report.view.name}`}
              </span>
              <span className="report-updated">
                {new Date(report.updatedAt).toLocaleString()}
              </span>
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
            </li>
          ))}
        </ul>
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
    </main>
  );
}
