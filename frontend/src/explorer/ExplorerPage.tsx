import { DndContext, type Announcements, type DragEndEvent } from "@dnd-kit/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch, ApiError } from "../api/client";
import { createExplore, updateExplore } from "../api/explores";
import { createReport } from "../api/reports";
import type {
  ExploreDefinition,
  ExploreDetail,
  Filter,
  QueryResponse,
  ReportDefinition,
  SemanticQueryBody,
  SemanticViewDetail,
  SemanticViewSummary,
} from "../api/types";
import ResultsTable from "../query/ResultsTable";
import SqlPreview from "../query/SqlPreview";
import ExploreFilters from "./ExploreFilters";
import ExploreVisual from "./ExploreVisual";
import SavedExploresPanel from "./SavedExploresPanel";
import Section from "./Section";
import VizPicker from "./VizPicker";
import { CATALOG, type VisualType } from "../reports/catalog";
import { isActive } from "../reports/filters";
import {
  announceDragCancel, announceDragEnd, announceDragOver, announceDragStart,
} from "./announcements";
import { useFieldSensors } from "./dndSensors";
import FieldPanel from "./FieldPanel";
import ViewTree from "./ViewTree";
import {
  canRender, effectiveType, exploreVisual, queryFieldsFor, unusedFields,
} from "./vizTypes";
import WellPanel from "./WellPanel";
import { addToWell, emptyWells, removeFromWell, wellsToQuery, type DragData, type WellId, type Wells } from "./wells";

function dragDataOf(active: { data: { current?: Record<string, unknown> } }): DragData | undefined {
  return active.data.current as DragData | undefined;
}

/** Looker's default, and a good one: enough rows to see the shape of an
 *  answer without waiting for a result set nobody reads. It is a starting
 *  point, not a ceiling -- the box takes any number up to the server's cap. */
const DEFAULT_ROW_LIMIT = 500;
/** The server's own cap (`row_cap`, and `MAX_ROW_LIMIT` on a saved explore).
 *  Clamped here so a number that would be silently reduced -- or refused on
 *  save -- cannot be typed in the first place. */
const MAX_ROW_LIMIT = 10000;

export default function ExplorerPage() {
  const navigate = useNavigate();
  const [selectedView, setSelectedView] = useState<SemanticViewSummary | null>(null);
  const [wells, setWells] = useState<Wells>(emptyWells());
  // Explore filters, in the same vocabulary reports use. Held here rather
  // than inside the query because they survive a re-run and are part of what
  // gets saved.
  const [filters, setFilters] = useState<Filter[]>([]);
  // The visual the user picked, or null while they are happy with the one
  // that fits. Kept separate from the effective type so that outgrowing a
  // pie and then removing the extra measure returns to the pie.
  const [chosenType, setChosenType] = useState<VisualType | null>(null);
  const [rowLimit, setRowLimit] = useState(DEFAULT_ROW_LIMIT);
  // The saved explore currently open, if any: Save updates it rather than
  // making a second copy every time.
  const [openExplore, setOpenExplore] = useState<ExploreDetail | null>(null);
  const [exploreName, setExploreName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const sensors = useFieldSensors();

  // dnd-kit's default announcer is purely geometric and knows nothing
  // about `canDrop`, so an invalid drop (a metric over Axis, say) would
  // otherwise be announced as if it succeeded. These consult the same
  // `canDrop` rule the wells model itself enforces, so the announcement
  // always matches what actually happened — this is also the only signal
  // an invalid drop gets during a keyboard drag (the blocked well's
  // `data-state`/cursor mean nothing to a screen reader).
  const announcements = useMemo<Announcements>(
    () => ({
      onDragStart({ active }) {
        const data = dragDataOf(active);
        return data ? announceDragStart(data.ref) : undefined;
      },
      onDragOver({ active, over }) {
        const data = dragDataOf(active);
        if (!data) return undefined;
        return announceDragOver(data.ref, data.kind, (over?.id as WellId | undefined) ?? null);
      },
      onDragEnd({ active, over }) {
        const data = dragDataOf(active);
        if (!data) return undefined;
        return announceDragEnd(data.ref, data.kind, (over?.id as WellId | undefined) ?? null);
      },
      onDragCancel() {
        return announceDragCancel();
      },
    }),
    [],
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

  const addToReport = useMutation({
    mutationFn: (definition: ReportDefinition) => createReport(definition),
    onSuccess: (report) => navigate(`/reports/${report.id}`),
  });

  // What is on screen, and what the hand-off produces: the same visual, so a
  // report opens showing the chart the explore was already showing.
  const visualType = effectiveType(chosenType, wells);
  const visual = exploreVisual(visualType, wells);
  const unused = unusedFields(visualType, wells);
  const totalFields = wells.axis.length + wells.legend.length + wells.values.length;
  // `canRender` as well as "something is selected": handing the server a
  // definition it rejects with a 400 naming an internal visual id is the one
  // outcome this button must never produce.
  const canAddToReport =
    selectedView !== null && totalFields > 0 && canRender(visualType, wells);

  function handleAddToReport() {
    if (!selectedView) return;
    const definition: ReportDefinition = {
      schemaVersion: 3,
      name: selectedView.name,
      view: {
        database: selectedView.database,
        schema: selectedView.schema,
        name: selectedView.name,
      },
      canvas: { columns: 12, rowHeight: 40 },
      pages: [
        {
          id: "p1",
          name: "Page 1",
          visuals: [
            {
              ...visual,
              id: `v${crypto.randomUUID().slice(0, 8)}`,
              // The filters travel with it. A report that opened showing more
              // rows than the explore did would be a different answer.
              filters: filters.filter(isActive),
            },
          ],
          filters: [],
        },
      ],
      filters: [],
      hierarchies: [],
    };
    addToReport.mutate(definition);
  }

  function selectView(view: SemanticViewSummary) {
    setSelectedView(view);
    setWells(emptyWells());
    // Filters name fields of the OLD view; carrying them across would send
    // references the new view has never heard of.
    setFilters([]);
    setChosenType(null);
    setOpenExplore(null);
    setExploreName("");
    setSaveError(null);
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
    const data = dragDataOf(active);
    if (!data) return;
    setWells((prev) => addToWell(prev, over.id as WellId, data.ref, data.kind));
  }

  function runQuery() {
    if (!selectedView) return;
    // Grouped by what the visual DRAWS. Following the selection
    // instead split each category across several rows, so a pie
    // drew one label twice at half its value and a gauge read one
    // arbitrary group -- and no client-side sum can recover a
    // non-additive measure computed at the wrong grain.
    const { dimensions, metrics } = queryFieldsFor(visualType, wells);
    run.mutate({
      database: selectedView.database,
      schema: selectedView.schema,
      view: selectedView.name,
      dimensions,
      metrics,
      // Unfinished filters are dropped here, exactly as they are for a
      // report tile: an empty IN list is a 422, not a filter.
      filters: filters.filter(isActive),
      limit: rowLimit,
    });
  }

  /** What this explore currently IS, as a saved document. */
  function currentDefinition(name: string): ExploreDefinition | null {
    if (!selectedView) return null;
    const { dimensions, metrics } = wellsToQuery(wells);
    return {
      schemaVersion: 1,
      name,
      view: {
        database: selectedView.database,
        schema: selectedView.schema,
        name: selectedView.name,
      },
      dimensions,
      metrics,
      filters,
      orderBy: [],
      limit: rowLimit,
    };
  }

  const queryClient = useQueryClient();

  const save = useMutation({
    mutationFn: (name: string) => {
      const definition = currentDefinition(name);
      if (!definition) return Promise.reject(new Error("Pick a semantic view first"));
      // An open explore is UPDATED. Saving a second copy under the same name
      // every time is how a list becomes unusable.
      return openExplore
        ? updateExplore(openExplore.id, definition)
        : createExplore(definition);
    },
    onSuccess: (saved) => {
      setOpenExplore(saved);
      setExploreName(saved.name);
      setSaveError(null);
      queryClient.invalidateQueries({ queryKey: ["explores"] });
    },
    onError: (error) => {
      setSaveError(
        error instanceof ApiError ? error.message : "Could not save this explore.",
      );
    },
  });

  /** Reopening a saved explore restores the whole query: view, fields and
   *  filters together. Restoring only some of it would show numbers that
   *  never belonged to the saved question. */
  function openSaved(explore: ExploreDetail) {
    const { view, dimensions, metrics, filters: saved, limit } = explore.definition;
    setSelectedView({
      database: view.database,
      schema: view.schema,
      name: view.name,
      comment: null,
    });
    let next = emptyWells();
    for (const ref of dimensions) next = addToWell(next, "axis", ref, "dimension");
    for (const ref of metrics) next = addToWell(next, "values", ref, "metric");
    setWells(next);
    setFilters(saved ?? []);
    setRowLimit(limit ?? DEFAULT_ROW_LIMIT);
    setChosenType(null);
    setOpenExplore(explore);
    setExploreName(explore.name);
    setSaveError(null);
    run.reset();
  }

  const activeFilterCount = filters.filter(isActive).length;

  return (
    <div className="explorer">
      <div className="explorer-toolbar">
        <h1 className="page-title">Explore</h1>
        <span className="explore-save">
          <label className="sr-only" htmlFor="explore-name">
            Explore name
          </label>
          <input
            id="explore-name"
            placeholder="Name this explore"
            value={exploreName}
            onChange={(e) => setExploreName(e.target.value)}
            disabled={!selectedView}
          />
          <button
            type="button"
            onClick={() => save.mutate(exploreName.trim())}
            disabled={!selectedView || !exploreName.trim() || save.isPending}
          >
            {save.isPending
              ? "Saving…"
              : openExplore
                ? "Save explore"
                : "Save as explore"}
          </button>
          {openExplore && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                // "Save a copy" is just forgetting which explore is open.
                setOpenExplore(null);
                setExploreName(`${exploreName} (copy)`.slice(0, 200));
              }}
            >
              Save a copy
            </button>
          )}
          {saveError && <span role="alert">{saveError}</span>}
        </span>
        <span className="identity-row">
          {/* The reason lives ON the disabled button rather than beside
              it. A line of instructions that is always on the page is read
              once and then becomes furniture; a tooltip on the control
              that is refusing you arrives exactly when you ask it to do
              something and it will not. `title` and `aria-label` both,
              because a tooltip a screen reader cannot reach is a reason
              only some readers get. */}
          <button
            type="button"
            className="add-to-report"
            onClick={handleAddToReport}
            disabled={!canAddToReport || addToReport.isPending}
            title={
              selectedView && !canAddToReport
                ? "Pick a field first — a report starts from something to show."
                : undefined
            }
            aria-label={
              selectedView && !canAddToReport
                ? "Add to report — pick a field first"
                : undefined
            }
          >
            {addToReport.isPending ? "Adding…" : "Add to report"}
          </button>
          {addToReport.isError && (
            <span role="alert">
              {addToReport.error instanceof ApiError
                ? addToReport.error.message
                : "Could not create report."}
            </span>
          )}
        </span>
      </div>
      <DndContext sensors={sensors} onDragEnd={onDragEnd} accessibility={{ announcements }}>
        {/* Two columns, as Looker has them: the field picker hard against
            the left edge, and one stack of sections to its right. The four
            columns this replaced spent 744px on chrome before a single
            number was shown, and made the picker the third thing across. */}
        <div className="columns">
          <div className="left">
            <h2 className="pane-heading">Views</h2>
            {views.isLoading && <p>Loading views...</p>}
            {views.isError && <p role="alert">Failed to load semantic views.</p>}
            {views.data && (
              <ViewTree
                views={views.data.views}
                selected={selectedView}
                onSelect={selectView}
              />
            )}
            <h2 className="pane-heading">Saved explores</h2>
            <SavedExploresPanel
              openId={openExplore?.id ?? null}
              onOpen={openSaved}
              onError={setSaveError}
            />
            <h2 className="pane-heading">Fields</h2>
            {selectedView && detail.data && (
              <FieldPanel detail={detail.data} wells={wells} onAdd={addField} />
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
            {!selectedView && <p>Pick a view to start exploring.</p>}
            {selectedView && detail.data && (
              <>
                <div className="explore-selected">
                  <WellPanel
                    wells={wells}
                    onRemove={removeField}
                    onRun={runQuery}
                    running={run.isPending}
                  />
                </div>

                <Section title="Filters" summary={`${activeFilterCount} active`}>
                  <ExploreFilters
                    view={{
                      database: selectedView.database,
                      schema: selectedView.schema,
                      name: selectedView.name,
                    }}
                    fields={[
                      ...detail.data.dimensions,
                      ...detail.data.metrics,
                      ...detail.data.facts,
                    ]}
                    filters={filters}
                    onChange={setFilters}
                  />
                </Section>

                <Section
                  title="Visualization"
                  summary={CATALOG[visualType].label}
                  actions={
                    <VizPicker wells={wells} active={visualType} onPick={setChosenType} />
                  }
                >
                  {run.isError && (
                    <p role="alert">
                      {run.error instanceof ApiError ? run.error.message : "Query failed"}
                    </p>
                  )}
                  {run.data?.bridgedThrough && (
                    <p className="explore-note">
                      {`Joined through ${run.data.bridgedThrough}. These fields have no
                      direct relationship, so the rows are the combinations that actually
                      occur there.`}
                    </p>
                  )}
                  {unused.length > 0 && run.data && (
                    <p className="explore-note">
                      {`Not shown by this visual: ${unused.join(", ")}. The table below has
                      every selected field.`}
                    </p>
                  )}
                  {run.data ? (
                    <ExploreVisual visual={visual} result={run.data} />
                  ) : (
                    <p className="tile-hint">Pick fields and press Run.</p>
                  )}
                </Section>

                <Section
                  title="Data"
                  summary={run.data ? `${run.data.rows.length} rows` : undefined}
                  actions={
                    <label className="row-limit">
                      Row limit
                      <input
                        type="number"
                        min={1}
                        max={MAX_ROW_LIMIT}
                        step={100}
                        value={rowLimit}
                        onChange={(e) =>
                          setRowLimit(
                            Math.min(
                              MAX_ROW_LIMIT,
                              Math.max(1, Number(e.target.value) || 1),
                            ),
                          )
                        }
                      />
                    </label>
                  }
                >
                  {run.data ? (
                    <>
                      <ResultsTable result={run.data} />
                      <SqlPreview sql={run.data.sql} />
                    </>
                  ) : (
                    <p className="tile-hint">No results yet.</p>
                  )}
                </Section>
              </>
            )}
          </div>
        </div>
      </DndContext>
    </div>
  );
}
