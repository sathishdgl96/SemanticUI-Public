import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, ApiError } from "../api/client";
import type {
  QueryResponse,
  SemanticQueryBody,
  SemanticViewDetail,
  SemanticViewSummary,
} from "../api/types";
import { useMe } from "../auth/useMe";
import FieldPanel, { type Selection } from "./FieldPanel";
import ViewTree from "./ViewTree";

// Replaced by QueryPanel in Task 16.
function QueryResults({ result }: { result: QueryResponse }) {
  return <pre data-testid="raw-result">{JSON.stringify(result, null, 2)}</pre>;
}

export default function ExplorerPage() {
  const navigate = useNavigate();
  const me = useMe();
  const [selectedView, setSelectedView] = useState<SemanticViewSummary | null>(null);
  const [selection, setSelection] = useState<Selection>({ dimensions: [], metrics: [] });

  const views = useQuery({
    queryKey: ["semantic-views"],
    queryFn: () =>
      apiFetch<{ views: SemanticViewSummary[] }>("/api/semantic-views"),
  });

  const detail = useQuery({
    queryKey: ["semantic-view", selectedView?.database, selectedView?.schema, selectedView?.name],
    enabled: selectedView !== null,
    queryFn: () =>
      apiFetch<SemanticViewDetail>(
        `/api/semantic-views/${selectedView!.database}/${selectedView!.schema}/${selectedView!.name}`,
      ),
  });

  const run = useMutation({
    mutationFn: (body: SemanticQueryBody) =>
      apiFetch<QueryResponse>("/api/query/semantic", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });

  function selectView(view: SemanticViewSummary) {
    setSelectedView(view);
    setSelection({ dimensions: [], metrics: [] });
    run.reset();
  }

  function toggle(kind: "dimensions" | "metrics", ref: string) {
    setSelection((prev) => ({
      ...prev,
      [kind]: prev[kind].includes(ref)
        ? prev[kind].filter((r) => r !== ref)
        : [...prev[kind], ref],
    }));
  }

  function runQuery() {
    if (!selectedView) return;
    run.mutate({
      database: selectedView.database,
      schema: selectedView.schema,
      view: selectedView.name,
      dimensions: selection.dimensions,
      metrics: selection.metrics,
    });
  }

  async function logout() {
    await apiFetch("/auth/logout", { method: "POST" });
    navigate("/login");
  }

  return (
    <div className="explorer">
      <header className="topbar">
        <strong>SemanticUI</strong>
        <span>
          {me.data ? `${me.data.snowflakeUser} @ ${me.data.snowflakeAccount}` : ""}
          <button className="link" onClick={logout}>
            Log out
          </button>
        </span>
      </header>
      <div className="columns">
        <div className="left">
          {views.isLoading && <p>Loading views...</p>}
          {views.isError && <p role="alert">Failed to load semantic views.</p>}
          {views.data && (
            <ViewTree
              views={views.data.views}
              selected={selectedView}
              onSelect={selectView}
            />
          )}
        </div>
        <div className="middle">
          {selectedView && detail.data && (
            <FieldPanel
              detail={detail.data}
              selection={selection}
              onToggle={toggle}
              onRun={runQuery}
              running={run.isPending}
            />
          )}
          {selectedView && detail.isLoading && <p>Describing view...</p>}
          {!selectedView && <p>Select a semantic view to begin.</p>}
        </div>
        <div className="main">
          {run.isError && (
            <p role="alert">
              {run.error instanceof ApiError ? run.error.message : "Query failed"}
            </p>
          )}
          {run.data && <QueryResults result={run.data} />}
        </div>
      </div>
    </div>
  );
}
