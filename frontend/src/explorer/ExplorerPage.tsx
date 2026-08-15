import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
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
import QueryPanel from "../query/QueryPanel";
import FieldPanel from "./FieldPanel";
import ViewTree from "./ViewTree";
import WellPanel from "./WellPanel";
import { addToWell, emptyWells, removeFromWell, wellsToQuery, type DragData, type WellId, type Wells } from "./wells";

export default function ExplorerPage() {
  const navigate = useNavigate();
  const me = useMe();
  const [selectedView, setSelectedView] = useState<SemanticViewSummary | null>(null);
  const [wells, setWells] = useState<Wells>(emptyWells());
  // `distance: 8` keeps PointerSensor from hijacking a plain click on a
  // field row (mousedown+mouseup with no movement) as a drag start, so
  // click-to-add stays a real, independent path from dragging.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

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
        `/api/semantic-views/${encodeURIComponent(selectedView!.database)}/${encodeURIComponent(
          selectedView!.schema,
        )}/${encodeURIComponent(selectedView!.name)}`,
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
    setWells(emptyWells());
    run.reset();
  }

  function addField(wellId: WellId, ref: string, kind: DragData["kind"]) {
    setWells((prev) => addToWell(prev, wellId, ref, kind));
  }

  function removeField(wellId: WellId, ref: string) {
    setWells((prev) => removeFromWell(prev, wellId, ref));
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const data = active.data.current as DragData | undefined;
    if (!data) return;
    setWells((prev) => addToWell(prev, over.id as WellId, data.ref, data.kind));
  }

  function runQuery() {
    if (!selectedView) return;
    const { dimensions, metrics } = wellsToQuery(wells);
    run.mutate({
      database: selectedView.database,
      schema: selectedView.schema,
      view: selectedView.name,
      dimensions,
      metrics,
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
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
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
              <>
                <FieldPanel detail={detail.data} wells={wells} onAdd={addField} />
                <WellPanel
                  wells={wells}
                  onRemove={removeField}
                  onRun={runQuery}
                  running={run.isPending}
                />
              </>
            )}
            {selectedView && detail.isLoading && <p>Describing view...</p>}
            {selectedView && detail.isError && (
              <div role="alert">
                <p>
                  {detail.error instanceof ApiError
                    ? detail.error.message
                    : "Failed to describe view."}
                </p>
                <button onClick={() => detail.refetch()}>Retry</button>
              </div>
            )}
            {!selectedView && <p>Select a semantic view to begin.</p>}
          </div>
          <div className="main">
            {run.isError && (
              <p role="alert">
                {run.error instanceof ApiError ? run.error.message : "Query failed"}
              </p>
            )}
            {run.data && detail.data && (
              <QueryPanel result={run.data} detail={detail.data} wells={wells} />
            )}
          </div>
        </div>
      </DndContext>
    </div>
  );
}
