import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import { downloadXlsx } from "../api/exports";
import { atLeast } from "../api/workspaces";
import type {
  AskSpec,
  Filter,
  Page,
  ReportDetail,
  SheetRequest,
  Visual,
  VisualLayout,
} from "../api/types";
import { useFieldSensors } from "../explorer/dndSensors";
import { visualTitle } from "../query/renderers";
import Pane from "../shell/Pane";
import BindViewPanel from "./builder/BindViewPanel";
import BuilderCanvasColumn from "./builder/BuilderCanvasColumn";
import BuilderDataPane from "./builder/BuilderDataPane";
import BuilderHeader from "./builder/BuilderHeader";
import BuilderOverlays from "./builder/BuilderOverlays";
import MovePanel from "./builder/MovePanel";
import PinToDashboard from "./builder/PinToDashboard";
import VisualizationsPane from "./builder/VisualizationsPane";
import { resolveDrop } from "./builder/dragDrop";
import type { PageOpResult } from "./builder/pageOps";
import { useBuilderInteraction } from "./builder/useBuilderInteraction";
import { useReportDocument } from "./builder/useReportDocument";
import { useViewFields } from "./builder/useViewFields";
import { viewMissingReason } from "./builder/viewBinding";
import {
  addField,
  mintVisual,
  removeFieldEverywhere,
  visualFromSpec,
  wellsWithField,
} from "./builder/visualOps";
import { CATALOG, wellsToQuery, type FieldKind, type VisualType } from "./catalog";
import FilterPane from "./FilterPane";
import { newFilterId, sheetRequestsFor } from "./filters";
import { changeVisualType } from "./VisualPicker";

export default function BuilderPage() {
  const { id } = useParams<{ id: string }>();
  const reportId = id ?? "";
  const navigate = useNavigate();
  const sensors = useFieldSensors();

  const doc = useReportDocument(reportId);
  const { definition, setDefinition } = doc;
  const ui = useBuilderInteraction(reportId);
  const view = definition?.view ?? { database: "", schema: "", name: "" };
  const fields = useViewFields(reportId, view, definition?.hierarchies);
  const { dimensions, metrics, factRefs, hierarchies } = fields;

  //: Filled in below, once `definition` is known to be non-null. The export
  //: mutation is declared before that point and would otherwise close over a
  //: variable in its temporal dead zone.
  const exportSheetsRef = useRef<() => SheetRequest[]>(() => []);
  //: The visual whose "Pin to dashboard" dialog is open, or null.
  const [pinning, setPinning] = useState<string | null>(null);
  const exportExcel = useMutation({
    mutationFn: () =>
      downloadXlsx(
        reportId,
        exportSheetsRef.current(),
        `${(doc.report.data?.name ?? "report").slice(0, 120)}.xlsx`,
      ),
  });

  // Error must be checked first: `definition` only ever leaves `null` when
  // `report.data` arrives, so on a failed fetch it stays `null` forever —
  // if the loading guard ran first, a failed load would trap every render
  // in "Loading report…" rather than ever reaching this branch.
  if (doc.report.isError) {
    return (
      <p role="alert">
        {doc.report.error instanceof ApiError
          ? doc.report.error.message
          : "Could not load this report."}
      </p>
    );
  }
  if (doc.report.isLoading || definition === null) {
    return <p>Loading report…</p>;
  }

  // The caller's role in this report's workspace. Absent on an older
  // response shape, in which case the safe reading is "cannot edit".
  const myRole = doc.report.data?.myRole ?? "viewer";
  const canEdit = atLeast(myRole, "editor");

  // A stale or absent id degrades to the first page rather than crashing:
  // pages can be deleted out from under the selection.
  const activePage =
    definition.pages.find((p) => p.id === ui.activePageId) ?? definition.pages[0];
  // A sheet page pins selection to its single pivot: the Data pane and the
  // wells behave like Excel's field list rather than needing a click first.
  const selected =
    activePage.kind === "sheet"
      ? activePage.visuals[0] ?? null
      : activePage.visuals.find((v) => v.id === ui.selectedId) ?? null;

  // Declared as `const ... = (...) => {}` (function expressions), not hoisted
  // `function` declarations, and placed after the `definition === null` guard
  // above: TypeScript only carries a narrowed type into a closure when the
  // closure is created after the check runs, which hoisted declarations
  // (visible before their narrowing point) don't qualify for. That's what
  // lets every reference to `definition` below stay typed as `ReportDefinition`
  // (not `| null`) without a non-null assertion.
  const replacePage = (next: Page) => {
    setDefinition({
      ...definition,
      pages: definition.pages.map((p) => (p.id === next.id ? next : p)),
    });
  };

  const replaceVisual = (next: Visual) => {
    replacePage({
      ...activePage,
      visuals: activePage.visuals.map((v) => (v.id === next.id ? next : v)),
    });
  };

  const switchPage = (pageId: string) => {
    if (pageId !== activePage.id) ui.focusPage(pageId);
  };

  const applyPageOp = (result: PageOpResult) => {
    if (result.notice) {
      ui.setNotice(result.notice);
      return;
    }
    if (result.definition) setDefinition(result.definition);
    if (result.focusId) ui.focusPage(result.focusId);
    if (result.selectId) ui.setSelectedId(result.selectId);
  };

  const addFilterAt = (scope: "report" | "page" | "visual", ref: string) => {
    const current =
      scope === "report"
        ? (definition.filters ?? [])
        : scope === "page"
          ? (activePage.filters ?? [])
          : (selected?.filters ?? []);
    // Already filtered at this scope: a second filter on the same field would
    // AND two conditions on one column, which is almost never what dropping
    // it again meant.
    if (current.some((f) => f.field === ref)) return;
    const next: Filter[] = [
      ...current,
      { id: newFilterId(), field: ref, op: "is", values: [] },
    ];
    if (scope === "report") setDefinition({ ...definition, filters: next });
    else if (scope === "page") replacePage({ ...activePage, filters: next });
    else if (selected) replaceVisual({ ...selected, filters: next });
  };

  const selectVisual = (visualId: string) => {
    // "" means the canvas itself was clicked: nothing is selected, and the
    // rail shows the page's own formatting instead of a visual's.
    ui.setSelectedId(visualId || null);
    const visual = activePage.visuals.find((v) => v.id === visualId);
    if (visual) ui.setSelectedType(visual.type as VisualType);
  };

  /** Remove a visual from the page. Nothing else has to be cleaned up: a
   *  dashboard tile naming it resolves to "no longer on the report" on its
   *  next read, which is the honest answer and needs no bookkeeping. */
  const deleteVisual = (visualId: string) => {
    replacePage({
      ...activePage,
      visuals: activePage.visuals.filter((v) => v.id !== visualId),
    });
    if (ui.selectedId === visualId) ui.setSelectedId(null);
  };

  const addVisual = (type: VisualType) => {
    const visual = mintVisual(activePage, type);
    replacePage({ ...activePage, visuals: [...activePage.visuals, visual] });
    ui.setSelectedId(visual.id);
    ui.setSelectedType(type);
  };

  const addFieldToSelected = (ref: string, kind: FieldKind) => {
    const visual = activePage.visuals.find((v) => v.id === ui.selectedId);
    if (!visual) return;
    const result = addField(visual, ref, kind);
    if (!result) return;
    if ("notice" in result) ui.setNotice(result.notice);
    else replaceVisual(result.visual);
  };

  /** PBI checkbox semantics for the Data pane. Checking with no visual
   *  selected creates one carrying the field -- exactly what PowerBI does --
   *  built in ONE setDefinition, because addVisual + addFieldToSelected in
   *  sequence would read stale state between the two updates. */
  const toggleField = (ref: string, kind: FieldKind, nextChecked: boolean) => {
    if (!canEdit) return;
    if (!nextChecked) {
      if (!selected) return;
      replaceVisual(removeFieldEverywhere(selected, ref));
      return;
    }
    if (selected) {
      addFieldToSelected(ref, kind);
      return;
    }
    const type = ui.selectedType;
    const visual = mintVisual(activePage, type, { wells: wellsWithField(type, kind, ref) });
    replacePage({ ...activePage, visuals: [...activePage.visuals, visual] });
    ui.setSelectedId(visual.id);
  };

  const addVisualFromSpec = (spec: AskSpec) => {
    const visual = visualFromSpec(activePage, spec);
    replacePage({ ...activePage, visuals: [...activePage.visuals, visual] });
    ui.setSelectedId(visual.id);
    ui.setPanel(null);
  };

  /** Exactly what each tile is showing right now, drill and cross-filter
   *  included. Built from the same helpers the tiles query with, so an export
   *  can never quietly disagree with the screen it came from. */
  const exportSheets = () =>
    sheetRequestsFor({
      pages: definition.pages,
      reportFilters: definition.filters ?? [],
      hierarchies,
      drill: ui.drill,
      crossFilter: ui.crossFilter,
      titleOf: (v, wells) => visualTitle({ ...v, wells }),
      wellsToQuery: (type, wells) => wellsToQuery(type as VisualType, wells),
    });

  exportSheetsRef.current = exportSheets;

  const onDragEnd = (event: DragEndEvent) => {
    // `selected`, not a fresh lookup: on a sheet page the pivot is pinned
    // and drops must land in it without a click-to-select first.
    const outcome = resolveDrop(event, selected);
    if (!outcome) return;
    if (outcome.kind === "addFilter") addFilterAt(outcome.scope, outcome.ref);
    else replaceVisual(outcome.visual);
  };

  const onLayoutChange = (next: Record<string, VisualLayout>) => {
    replacePage({
      ...activePage,
      visuals: activePage.visuals.map((v) =>
        next[v.id] ? { ...v, layout: next[v.id] } : v,
      ),
    });
  };

  const onTypeChange = (nextType: VisualType) => {
    ui.setSelectedType(nextType);
    const visual =
      activePage.kind === "sheet"
        ? activePage.visuals[0]
        : activePage.visuals.find((v) => v.id === ui.selectedId);
    if (!visual) return;
    const { visual: updated, dropped } = changeVisualType(visual, nextType);
    replaceVisual(updated);
    // Fields now follow the visual across types, so this only fires when the
    // new type genuinely has no well of that kind with room left.
    ui.setNotice(
      dropped.length
        ? `${CATALOG[nextType].label} has no room for ${dropped.join(", ")}.`
        : null,
    );
  };

  // Import always creates a *new* report (see `POST /api/reports/import`),
  // so landing here mid-edit hands off to that new report's own builder
  // route rather than trying to merge it into the one currently open.
  const onImported = (imported: ReportDetail) => {
    ui.setPanel(null);
    navigate(`/reports/${imported.id}`);
  };

  return (
    <div className="builder">
      <BuilderHeader
        name={definition.name}
        onRename={(name) => setDefinition({ ...definition, name })}
        canEdit={canEdit}
        dirty={doc.dirty}
        saving={doc.save.isPending}
        onSave={() => doc.save.mutate()}
        moving={ui.moving}
        onToggleMove={() => ui.setMoving((open) => !open)}
        panel={ui.panel}
        onTogglePanel={(kind) => ui.setPanel(ui.panel === kind ? null : kind)}
        mode={ui.mode}
        onSetMode={ui.setMode}
        viewName={view.name}
        exporting={exportExcel.isPending}
        onExportExcel={() => exportExcel.mutate()}
      />
      {!canEdit && (
        <p className="tile-hint">
          You have the {myRole} role in {doc.report.data?.workspaceName || "this workspace"},
          so this report is read-only for you. Its data still runs on your own
          Snowflake credentials.
        </p>
      )}
      {ui.moving && canEdit && (
        <MovePanel reportId={reportId} onDone={() => ui.setMoving(false)} />
      )}
      {doc.save.isError && (
        <p role="alert">
          {doc.save.error instanceof ApiError
            ? doc.save.error.message
            : "Could not save this report."}
        </p>
      )}
      {ui.notice && <p className="notice">{ui.notice}</p>}
      {fields.needsBind ? (
        <BindViewPanel
          reason={view.name ? viewMissingReason(view) : null}
          onBind={doc.bindView}
          canEdit={canEdit}
          binding={doc.bind.isPending}
          bindError={
            doc.bind.isError
              ? doc.bind.error instanceof ApiError
                ? doc.bind.error.message
                : "Could not save that view to this report."
              : null
          }
        />
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          {ui.crossFilter && (
            // role="status" rather than a bare div: a filter applied by
            // clicking somewhere else has to be announced, not just drawn.
            <p className="cross-filter-chip" role="status">
              Filtered by {ui.crossFilter.field} = {ui.crossFilter.value}
              <button type="button" className="link" onClick={() => ui.setCrossFilter(null)}>
                Clear cross-filter
              </button>
            </p>
          )}
          <div className="builder-body">
            <BuilderCanvasColumn
              definition={definition}
              activePage={activePage}
              view={view}
              hierarchies={hierarchies}
              factRefs={factRefs}
              viewDetail={fields.viewDetail.data}
              canEdit={canEdit}
              ui={ui}
              onSelect={selectVisual}
              onLayoutChange={onLayoutChange}
              onSwitchPage={switchPage}
              onPageOp={applyPageOp}
              onDeleteVisual={canEdit ? deleteVisual : undefined}
              onPinVisual={setPinning}
            />
            {/* The rail acts on the report: filters, the visual being
                edited, the fields going into it. In model view there is no
                visual and nothing to filter, so the rail is three panes of
                controls for something that is not on screen -- and the
                diagram is what wants the width. */}
            {ui.mode !== "model" && (
            <aside className="builder-rail">
              <Pane title="Filters" defaultCollapsed={ui.startFiltersCollapsed}>
                <FilterPane
                  view={view}
                  fields={[...dimensions, ...metrics]}
                  reportFilters={definition.filters ?? []}
                  pageFilters={activePage.filters ?? []}
                  visualFilters={selected ? (selected.filters ?? []) : null}
                  selectedVisualTitle={selected ? visualTitle(selected) : null}
                  onChangeReport={(filters) => setDefinition({ ...definition, filters })}
                  onChangePage={(filters) => replacePage({ ...activePage, filters })}
                  onChangeVisual={(filters) => {
                    if (selected) replaceVisual({ ...selected, filters });
                  }}
                />
              </Pane>
              <VisualizationsPane
                isSheet={activePage.kind === "sheet"}
                selected={selected}
                selectedType={ui.selectedType}
                onTypeChange={onTypeChange}
                onAddVisual={() => addVisual(ui.selectedType)}
                paneTab={ui.paneTab}
                onPaneTab={ui.setPaneTab}
                onChangeVisual={replaceVisual}
                factRefs={factRefs}
                fields={[...dimensions, ...metrics]}
                canvasBackground={definition.canvas.background}
                onCanvasBackground={(background) =>
                  setDefinition({
                    ...definition,
                    canvas: { ...definition.canvas, background },
                  })
                }
              />
              <BuilderDataPane
                fields={fields}
                viewName={view.name}
                selected={selected}
                canEdit={canEdit}
                onToggleField={toggleField}
                onAddField={addFieldToSelected}
                onHierarchiesChange={(next) =>
                  setDefinition({
                    ...definition,
                    // Model-declared hierarchies are not the report's to store.
                    hierarchies: next.filter((h) => !h.id.startsWith("model:")),
                  })
                }
              />
            </aside>
            )}
          </div>
        </DndContext>
      )}
      {pinning && doc.report.data && (
        <div className="panel-overlay">
          <PinToDashboard
            reportId={reportId}
            workspaceId={doc.report.data.workspaceId}
            pageId={activePage.id}
            visualId={pinning}
            visualTitle={
              visualTitle(activePage.visuals.find((v) => v.id === pinning) ?? selected!) ||
              "this visual"
            }
            onClose={() => setPinning(null)}
          />
        </div>
      )}
      <BuilderOverlays
        panel={ui.panel}
        onClose={() => ui.setPanel(null)}
        reportId={reportId}
        onImported={onImported}
        exportPending={exportExcel.isPending}
        exportError={
          exportExcel.isError
            ? exportExcel.error instanceof ApiError
              ? exportExcel.error.message
              : "Could not export this report."
            : null
        }
        connectSheets={exportSheets}
        feedVisuals={activePage.visuals
          .filter((v) => v.type !== "slicer")
          .map((v) => ({ id: v.id, title: visualTitle(v) }))}
        canEdit={canEdit}
        onAddVisual={addVisualFromSpec}
      />
    </div>
  );
}
