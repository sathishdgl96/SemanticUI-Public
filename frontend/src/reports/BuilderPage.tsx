import { DndContext, useDraggable, type DragEndEvent } from "@dnd-kit/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiFetch, ApiError } from "../api/client";
import { getReport, updateReport } from "../api/reports";
import { atLeast, moveReport } from "../api/workspaces";
import AskPanel from "../ask/AskPanel";
import ConnectPanel from "../export/ConnectPanel";
import Pane from "../shell/Pane";
import DataPane from "./DataPane";
import { downloadXlsx } from "../api/exports";
import { useWorkspaces } from "../workspaces/useWorkspaces";
import type {
  AskSpec,
  FieldInfo,
  SheetRequest,
  Filter,
  Hierarchy,
  Page,
  ReportDefinition,
  ReportDetail,
  SemanticViewDetail,
  SemanticViewSummary,
  ViewRef,
  Visual,
  VisualLayout,
} from "../api/types";
import { useFieldSensors } from "../explorer/dndSensors";
import ViewTree from "../explorer/ViewTree";
import { visualTitle } from "../query/renderers";
import {
  CATALOG,
  MAX_PAGES,
  MAX_VISUALS,
  defaultWellFor,
  emptyWellsFor,
  wellsToQuery,
  type FieldKind,
  type VisualType,
} from "./catalog";
import CanvasGrid from "./CanvasGrid";
import ExportPanel from "./ExportPanel";
import FilterPane, { PAGE_DROP_ID, REPORT_DROP_ID, VISUAL_DROP_ID } from "./FilterPane";
import PageBar from "./PageBar";
import {
  HIERARCHY_PREFIX,
  newFilterId,
  sheetRequestsFor,
  type CrossFilter,
  type DrillState,
} from "./filters";
import HierarchyPane from "./HierarchyPane";
import ImportPanel from "./ImportPanel";
import { normalizeDefinition } from "./normalize";
import VisualPicker, { changeVisualType } from "./VisualPicker";
import VisualWells from "./VisualWells";

/** `apiFetch` only ever throws real `ApiError` instances, so `instanceof`
 *  is sound here — no need to duck-type `status`/`code` off an `unknown`. */
function isMissingView(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status === 404 || error.code === "SNOWFLAKE_FORBIDDEN" || error.code === "QUERY_ERROR";
}

function viewMissingReason(view: ViewRef): string {
  return (
    `Could not open ${view.database}.${view.schema}.${view.name}. It may have been ` +
    "renamed or dropped, or your Snowflake role may no longer have access to it."
  );
}

function describeUrl(view: ViewRef, refresh = false): string {
  const base = `/api/semantic-views/${encodeURIComponent(view.database)}/${encodeURIComponent(
    view.schema,
  )}/${encodeURIComponent(view.name)}`;
  return refresh ? `${base}?refresh=true` : base;
}

/** Shared by both "no view bound yet" (fresh report) and "the bound view no
 *  longer resolves" (deleted/forbidden) — both cases hand the user the same
 *  view tree so binding to a replacement view is one consistent flow. */
function BindViewPanel({
  reason,
  onBind,
}: {
  reason: string | null;
  onBind: (view: SemanticViewSummary) => void;
}) {
  const [open, setOpen] = useState(reason === null);
  const views = useQuery({
    queryKey: ["semantic-views"],
    queryFn: () => apiFetch<{ views: SemanticViewSummary[] }>("/api/semantic-views"),
    enabled: open,
  });

  return (
    <div className="builder-bind">
      {reason ? (
        <>
          <p role="alert">{reason}</p>
          {!open && (
            <button type="button" onClick={() => setOpen(true)}>
              Choose another view
            </button>
          )}
        </>
      ) : (
        <p>Pick a semantic view to start this report.</p>
      )}
      {open && (
        <>
          {views.isLoading && <p>Loading views…</p>}
          {views.isError && <p role="alert">Could not load semantic views.</p>}
          {views.data && <ViewTree views={views.data.views} selected={null} onSelect={onBind} />}
        </>
      )}
    </div>
  );
}

function refOf(field: FieldInfo): string {
  return `${field.table}.${field.name}`;
}

function BuilderFieldRow({
  field,
  kind,
  onAdd,
}: {
  field: FieldInfo;
  kind: FieldKind;
  onAdd: (ref: string, kind: FieldKind) => void;
}) {
  const ref = refOf(field);
  const { attributes, listeners, setNodeRef } = useDraggable({ id: ref, data: { ref, kind } });
  return (
    <button
      type="button"
      ref={setNodeRef}
      className="field-row"
      onClick={() => onAdd(ref, kind)}
      {...listeners}
      {...attributes}
    >
      <span className="field-glyph">{kind === "metric" ? "Σ" : "⬦"}</span>
      {/* Just the field name: the Data pane already groups by table, so the
          prefix is redundant and it truncated every row. The full ref stays
          available as the tooltip and in the checkbox's accessible name. */}
      <span className="field-ref" title={ref}>
        {field.name}
      </span>
      {field.dataType && <small>{field.dataType}</small>}
    </button>
  );
}


/** Hierarchies are placed exactly like dimensions -- click or drag -- but
 *  carry a "hierarchy:<id>" reference instead of a field name. Without this
 *  row there is no way to put one on an axis at all. */
function BuilderHierarchyRow({
  hierarchy,
  onAdd,
}: {
  hierarchy: Hierarchy;
  onAdd: (ref: string, kind: FieldKind) => void;
}) {
  const ref = `${HIERARCHY_PREFIX}${hierarchy.id}`;
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: ref,
    data: { ref, kind: "dimension" as FieldKind },
  });
  return (
    <button
      type="button"
      ref={setNodeRef}
      className="field-row"
      // Explicit, so the decorative glyph stays out of the accessible name
      // and the level count is announced as a phrase rather than a fragment.
      aria-label={`${hierarchy.name} hierarchy, ${hierarchy.levels.length} levels`}
      onClick={() => onAdd(ref, "dimension")}
      {...listeners}
      {...attributes}
    >
      <span className="field-glyph">⛭</span>
      <span className="field-ref">{hierarchy.name}</span>
      <small>{hierarchy.levels.length} levels</small>
    </button>
  );
}

/** Only workspaces the caller can write to are offered. Moving needs editor
 *  on BOTH ends, so listing a read-only workspace would only produce a 403. */
function MovePanel({ reportId, onDone }: { reportId: string; onDone: () => void }) {
  const workspaces = useWorkspaces();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState("");

  const move = useMutation({
    mutationFn: () => moveReport(reportId, target),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      queryClient.invalidateQueries({ queryKey: ["report", reportId] });
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      onDone();
    },
  });

  const writable = (workspaces.data?.workspaces ?? []).filter((w) =>
    atLeast(w.myRole, "editor"),
  );

  return (
    <form
      className="move-panel"
      onSubmit={(e) => {
        e.preventDefault();
        if (target) move.mutate();
      }}
    >
      <label>
        Move to
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose a workspace…</option>
          {writable.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={!target || move.isPending}>
        {move.isPending ? "Moving…" : "Move report"}
      </button>
      <button type="button" className="link" onClick={onDone}>
        Cancel
      </button>
      {move.isError && (
        <p role="alert">
          {move.error instanceof ApiError
            ? move.error.message
            : "Could not move this report."}
        </p>
      )}
    </form>
  );
}

export default function BuilderPage() {
  const { id } = useParams<{ id: string }>();
  const reportId = id ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sensors = useFieldSensors();

  const report = useQuery({
    queryKey: ["report", reportId],
    queryFn: () => getReport(reportId),
    enabled: Boolean(reportId),
  });

  const [definition, setDefinition] = useState<ReportDefinition | null>(null);
  const [savedJson, setSavedJson] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<VisualType>("bar");
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<
    "export" | "import" | "ask" | "connect" | null
  >(null);
  // Ephemeral by design: never written to the definition, so a saved report
  // always opens at the top level with nothing selected, and can never point
  // at a value that has since disappeared from the view.
  //: Filled in below, once `definition` is known to be non-null. The export
  //: mutation is declared before that point and would otherwise close over a
  //: variable in its temporal dead zone.
  const exportSheetsRef = useRef<() => SheetRequest[]>(() => []);
  const [drill, setDrill] = useState<Record<string, DrillState>>({});
  const [crossFilter, setCrossFilter] = useState<CrossFilter | null>(null);
  // Slicer ticks, keyed by field ref. Ephemeral like drill and cross-filter:
  // never written to the definition, so a viewer who cannot save can still
  // slice a shared report.
  const [slicerSelections, setSlicerSelections] = useState<Record<string, string[]>>({});
  const [moving, setMoving] = useState(false);
  // Which page tab is open. Ephemeral like the selection: a saved report
  // always opens on its first page.
  const [activePageId, setActivePageId] = useState<string | null>(null);
  // On narrower desktops PowerBI shows two panes open; Filters starts tucked
  // away. Guarded: jsdom has no matchMedia.
  const [startFiltersCollapsed] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 1279px)").matches,
  );

  // The route element isn't keyed in App.tsx, so navigating from one report
  // to another (e.g. BuilderPage's own Import flow, which navigates to the
  // freshly-imported report's id) reuses this same component instance
  // rather than remounting it. Without this reset, the populate effect below
  // (guarded by `definition === null`) would never fire again once
  // `definition` already holds the PREVIOUS report's data — leaving the old
  // definition on screen, editable, with Save posting it to the new id.
  // Everything else scoped to "the report currently being edited" is reset
  // here too: a stale `notice` (e.g. a dropped-wells message) from the old
  // report would otherwise keep rendering under the new one; an open
  // Export/Import `panel` should not silently carry over rather than being
  // cleared defensively (it happened to work before only because
  // `onImported` itself called `setPanel(null)`); and `save`/`refreshFields`
  // are `useMutation` objects that keep their `isError`/`error` until the
  // next `.mutate()` or an explicit `.reset()` — without resetting them
  // here, failing a Save on report A and then navigating to report B would
  // show report A's failure alert attributed to a report the user never
  // touched.
  useEffect(() => {
    setDefinition(null);
    setSavedJson(null);
    setSelectedId(null);
    setActivePageId(null);
    setNotice(null);
    setPanel(null);
    setDrill({});
    setCrossFilter(null);
    setSlicerSelections({});
    setMoving(false);
    save.reset();
    refreshFields.reset();
    // `save`/`refreshFields` deliberately left out of the dependency array:
    // react-query hands back a new mutation result object on every render
    // (its `isPending`/`isError`/etc. all live on that object), so listing
    // them here would re-run this effect — and re-clear `definition` — on
    // every render, not just when `reportId` actually changes. This effect
    // only needs to run on a report-identity change; the `.reset` calls
    // above always see the current render's mutation objects regardless of
    // whether those objects are declared as dependencies.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId]);

  useEffect(() => {
    if (report.data && definition === null) {
      // Normalised on the way in, so a document from an older server (or an
      // older cached response) cannot reach the render tree without `pages`
      // and blank the whole builder.
      const normalized = normalizeDefinition(report.data.definition);
      setDefinition(normalized);
      // The baseline is the NORMALISED document, not the raw one: comparing
      // against the raw shape would mark an untouched report dirty the
      // moment it loaded.
      setSavedJson(JSON.stringify(normalized));
    }
  }, [report.data, definition]);

  const view = definition?.view ?? { database: "", schema: "", name: "" };

  const viewDetail = useQuery({
    queryKey: ["report-view-detail", view.database, view.schema, view.name],
    queryFn: () => apiFetch<SemanticViewDetail>(describeUrl(view)),
    enabled: Boolean(view.name),
  });

  const refreshFields = useMutation({
    mutationFn: () => apiFetch<SemanticViewDetail>(describeUrl(view, true)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["report-view-detail"] });
      queryClient.invalidateQueries({ queryKey: ["visual-query"] });
    },
  });

  const save = useMutation({
    mutationFn: () => {
      if (!definition) return Promise.reject(new Error("Report not loaded"));
      return updateReport(reportId, definition);
    },
    onSuccess: (saved) => {
      setSavedJson(JSON.stringify(saved.definition));
      queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
  });

  const exportExcel = useMutation({
    mutationFn: () =>
      downloadXlsx(
        reportId,
        exportSheetsRef.current(),
        `${(report.data?.name ?? "report").slice(0, 120)}.xlsx`,
      ),
  });

  // Error must be checked first: `definition` only ever leaves `null` when
  // `report.data` arrives, so on a failed fetch it stays `null` forever —
  // if the loading guard ran first, a failed load would trap every render
  // in "Loading report…" rather than ever reaching this branch.
  if (report.isError) {
    return (
      <p role="alert">
        {report.error instanceof ApiError ? report.error.message : "Could not load this report."}
      </p>
    );
  }
  if (report.isLoading || definition === null) {
    return <p>Loading report…</p>;
  }

  // The caller's role in this report's workspace. Absent on an older
  // response shape, in which case the safe reading is "cannot edit".
  const myRole = report.data?.myRole ?? "viewer";
  const canEdit = atLeast(myRole, "editor");

  const dirty = JSON.stringify(definition) !== savedJson;
  // A stale or absent id degrades to the first page rather than crashing:
  // pages can be deleted out from under the selection.
  const activePage = definition.pages.find((p) => p.id === activePageId) ?? definition.pages[0];
  const selected = activePage.visuals.find((v) => v.id === selectedId) ?? null;
  const needsBind = !view.name || (viewDetail.isError && isMissingView(viewDetail.error));

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

  /** Selection and cross-filter are page-local, as they are in PowerBI: a
   *  selection on one page must not keep constraining another. */
  const focusPage = (id: string) => {
    setActivePageId(id);
    setSelectedId(null);
    setCrossFilter(null);
    // Slicers live on a page too, so their ticks leave with it.
    setSlicerSelections({});
  };

  const switchPage = (id: string) => {
    if (id !== activePage.id) focusPage(id);
  };

  const addPage = () => {
    if (definition.pages.length >= MAX_PAGES) {
      setNotice(`A report can hold at most ${MAX_PAGES} pages.`);
      return;
    }
    const used = new Set(definition.pages.map((p) => p.name));
    let n = definition.pages.length + 1;
    while (used.has(`Page ${n}`)) n++;
    const page: Page = {
      id: `p${crypto.randomUUID().slice(0, 8)}`,
      name: `Page ${n}`,
      visuals: [],
      filters: [],
    };
    setDefinition({ ...definition, pages: [...definition.pages, page] });
    focusPage(page.id);
  };

  const renamePage = (id: string, name: string) => {
    setDefinition({
      ...definition,
      pages: definition.pages.map((p) => (p.id === id ? { ...p, name } : p)),
    });
  };

  const duplicatePage = (id: string) => {
    const source = definition.pages.find((p) => p.id === id);
    if (!source) return;
    if (definition.pages.length >= MAX_PAGES) {
      setNotice(`A report can hold at most ${MAX_PAGES} pages.`);
      return;
    }
    const total = definition.pages.reduce((sum, p) => sum + p.visuals.length, 0);
    if (total + source.visuals.length > MAX_VISUALS) {
      setNotice(
        `Duplicating this page would exceed ${MAX_VISUALS} visuals per report.`,
      );
      return;
    }
    const used = new Set(definition.pages.map((p) => p.name));
    let name = `Duplicate of ${source.name}`.slice(0, 100);
    for (let n = 2; used.has(name); n++) {
      name = `Duplicate of ${source.name} ${n}`.slice(0, 100);
    }
    const copy: Page = {
      id: `p${crypto.randomUUID().slice(0, 8)}`,
      name,
      // Visual ids must be unique across the WHOLE report, so a copy mints
      // fresh ones. Filter ids only have to be unique within their scope.
      visuals: source.visuals.map((v) => ({
        ...structuredClone(v),
        id: `v${crypto.randomUUID().slice(0, 8)}`,
      })),
      filters: source.filters.map((f) => ({ ...f })),
    };
    const at = definition.pages.findIndex((p) => p.id === id) + 1;
    const pages = [...definition.pages];
    pages.splice(at, 0, copy);
    setDefinition({ ...definition, pages });
    focusPage(copy.id);
  };

  const deletePage = (id: string) => {
    if (definition.pages.length <= 1) return;
    const remaining = definition.pages.filter((p) => p.id !== id);
    setDefinition({ ...definition, pages: remaining });
    if (activePage.id === id) focusPage(remaining[0].id);
  };

  const movePage = (id: string, direction: -1 | 1) => {
    const from = definition.pages.findIndex((p) => p.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= definition.pages.length) return;
    const pages = [...definition.pages];
    const [page] = pages.splice(from, 1);
    pages.splice(to, 0, page);
    setDefinition({ ...definition, pages });
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
    setSelectedId(visualId);
    const visual = activePage.visuals.find((v) => v.id === visualId);
    if (visual) setSelectedType(visual.type as VisualType);
  };

  const addVisual = (type: VisualType) => {
    const nextY = activePage.visuals.reduce(
      (max, v) => Math.max(max, v.layout.y + v.layout.h),
      0,
    );
    const visual: Visual = {
      id: `v${crypto.randomUUID().slice(0, 8)}`,
      type,
      title: "",
      layout: { x: 0, y: nextY, w: 6, h: 6 },
      wells: emptyWellsFor(type),
      options: {},
      filters: [],
    };
    replacePage({ ...activePage, visuals: [...activePage.visuals, visual] });
    setSelectedId(visual.id);
    setSelectedType(type);
  };

  /** PBI checkbox semantics for the Data pane. Checking with no visual
   *  selected creates one carrying the field -- exactly what PowerBI does --
   *  built in ONE setDefinition, because addVisual + addFieldToSelected in
   *  sequence would read stale state between the two updates. */
  const toggleField = (ref: string, kind: FieldKind, nextChecked: boolean) => {
    if (!canEdit) return;
    if (!nextChecked) {
      if (!selected) return;
      replaceVisual({
        ...selected,
        wells: Object.fromEntries(
          Object.entries(selected.wells).map(([key, refs]) => [
            key,
            refs.filter((r) => r !== ref),
          ]),
        ),
      });
      return;
    }
    if (selected) {
      addFieldToSelected(ref, kind);
      return;
    }
    const type = selectedType;
    const wells = emptyWellsFor(type);
    const wellKey = defaultWellFor(type, kind, wells);
    if (wellKey) wells[wellKey] = [ref];
    const nextY = activePage.visuals.reduce(
      (max, v) => Math.max(max, v.layout.y + v.layout.h),
      0,
    );
    const visual: Visual = {
      id: `v${crypto.randomUUID().slice(0, 8)}`,
      type,
      title: "",
      layout: { x: 0, y: nextY, w: 6, h: 6 },
      wells,
      options: {},
      filters: [],
    };
    replacePage({ ...activePage, visuals: [...activePage.visuals, visual] });
    setSelectedId(visual.id);
  };

  const addFieldToSelected = (ref: string, kind: FieldKind) => {
    const visual = activePage.visuals.find((v) => v.id === selectedId);
    if (!visual) return;
    // Same cross-well dedupe `onDragEnd` applies: a ref already sitting in
    // ANY well of this visual is a no-op, not another append — otherwise
    // clicking the same field row repeatedly kept stacking duplicates into
    // an unbounded well (e.g. Values).
    if (Object.values(visual.wells).some((refs) => refs.includes(ref))) return;
    const wellKey = defaultWellFor(visual.type as VisualType, kind, visual.wells);
    if (!wellKey) {
      setNotice(`Every ${kind} well on this visual is full.`);
      return;
    }
    replaceVisual({
      ...visual,
      wells: { ...visual.wells, [wellKey]: [...(visual.wells[wellKey] ?? []), ref] },
    });
  };

  /** Pin an answer onto the canvas. The spec already speaks the well
   *  vocabulary, so this is a re-shaping rather than a translation. */
  const addVisualFromSpec = (spec: AskSpec) => {
    const nextY = activePage.visuals.reduce(
      (max, v) => Math.max(max, v.layout.y + v.layout.h),
      0,
    );
    const visual: Visual = {
      id: `v${crypto.randomUUID().slice(0, 8)}`,
      type: "bar",
      title: spec.explanation.slice(0, 200),
      layout: { x: 0, y: nextY, w: 6, h: 6 },
      wells: {
        ...emptyWellsFor("bar"),
        axis: spec.dimensions.slice(0, 1),
        values: spec.metrics,
      },
      options: {},
      // The answer's filters travel with it, or the pinned tile would show a
      // different number from the one that was just on screen.
      filters: spec.filters,
    };
    replacePage({ ...activePage, visuals: [...activePage.visuals, visual] });
    setSelectedId(visual.id);
    setPanel(null);
  };

  /** Exactly what each tile is showing right now, drill and cross-filter
   *  included. Built from the same helpers the tiles query with, so an export
   *  can never quietly disagree with the screen it came from. */
  const exportSheets = () =>
    sheetRequestsFor({
      pages: definition.pages,
      reportFilters: definition.filters ?? [],
      hierarchies,
      drill,
      crossFilter,
      titleOf: (v, wells) => visualTitle({ ...v, wells }),
      wellsToQuery: (type, wells) => wellsToQuery(type as VisualType, wells),
    });

  exportSheetsRef.current = exportSheets;

  const onDragEnd = (event: DragEndEvent) => {
    const visual = activePage.visuals.find((v) => v.id === selectedId);
    const overId = String(event.over?.id ?? "");
    const data = event.active.data.current as { ref: string; kind: FieldKind } | undefined;
    // Filter scopes first: the well branch below returns early for any id it
    // does not recognise, so it would swallow these.
    const scope =
      overId === REPORT_DROP_ID
        ? "report"
        : overId === PAGE_DROP_ID
          ? "page"
          : overId === VISUAL_DROP_ID
            ? "visual"
            : null;
    if (data && scope) {
      addFilterAt(scope, data.ref);
      return;
    }
    if (!visual || !data || !overId.startsWith("well:")) return;
    const key = overId.slice("well:".length);
    const spec = CATALOG[visual.type as VisualType].wells.find((w) => w.key === key);
    if (!spec || spec.kind !== data.kind) return; // wrong kind: refuse
    const current = visual.wells[key] ?? [];
    if (current.includes(data.ref)) return; // already there
    if (Object.values(visual.wells).some((refs) => refs.includes(data.ref))) return; // another well
    const next = spec.max === 1 ? [data.ref] : [...current, data.ref];
    replaceVisual({ ...visual, wells: { ...visual.wells, [key]: next } });
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
    setSelectedType(nextType);
    const visual = activePage.visuals.find((v) => v.id === selectedId);
    if (!visual) return;
    const { visual: updated, dropped } = changeVisualType(visual, nextType);
    replaceVisual(updated);
    // Fields now follow the visual across types, so this only fires when the
    // new type genuinely has no well of that kind with room left.
    setNotice(
      dropped.length
        ? `${CATALOG[nextType].label} has no room for ${dropped.join(", ")}.`
        : null,
    );
  };

  const bindView = (picked: SemanticViewSummary) => {
    setDefinition({
      ...definition,
      view: { database: picked.database, schema: picked.schema, name: picked.name },
    });
  };

  // Import always creates a *new* report (see `POST /api/reports/import`),
  // so landing here mid-edit hands off to that new report's own builder
  // route rather than trying to merge it into the one currently open.
  const onImported = (imported: ReportDetail) => {
    setPanel(null);
    navigate(`/reports/${imported.id}`);
  };

  const dimensions = viewDetail.data?.dimensions ?? [];
  const metrics = viewDetail.data?.metrics ?? [];
  // Model-declared hierarchies (none on today's accounts -- see
  // detect_hierarchies) plus the report's own. Ids are namespaced, so the two
  // sources can never collide.
  const hierarchies: Hierarchy[] = [
    ...(viewDetail.data?.modelHierarchies ?? []),
    ...(definition.hierarchies ?? []),
  ];


  return (
    <div className="builder">
      <header className="builder-head command-bar">
        <input
          className="report-title"
          aria-label="Report name"
          value={definition.name}
          onChange={(e) => setDefinition({ ...definition, name: e.target.value })}
        />
        <div className="builder-actions">
          <button
            onClick={() => save.mutate()}
            disabled={!canEdit || !dirty || save.isPending}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          {canEdit && (
            <button
              type="button"
              className="secondary"
              aria-pressed={moving}
              onClick={() => setMoving((open) => !open)}
            >
              Move
            </button>
          )}
          <span className="cmd-sep" aria-hidden="true" />
          <button
            type="button"
            className="secondary"
            aria-pressed={panel === "ask"}
            onClick={() => setPanel(panel === "ask" ? null : "ask")}
          >
            Ask
          </button>
          <button
            type="button"
            className="secondary"
            disabled={exportExcel.isPending}
            onClick={() => exportExcel.mutate()}
          >
            {exportExcel.isPending ? "Exporting…" : "Excel"}
          </button>
          <button
            type="button"
            className="secondary"
            aria-pressed={panel === "connect"}
            onClick={() => setPanel(panel === "connect" ? null : "connect")}
          >
            Connect live
          </button>
          <span className="cmd-sep" aria-hidden="true" />
          <button
            type="button"
            className="secondary"
            aria-pressed={panel === "export"}
            onClick={() => setPanel(panel === "export" ? null : "export")}
          >
            Export
          </button>
          {/* Import CREATES a report, so a viewer has nowhere to put one.
              Export stays available to everyone -- reading is what they can
              already do. */}
          {canEdit && (
            <button
              type="button"
              className="secondary"
              aria-pressed={panel === "import"}
              onClick={() => setPanel(panel === "import" ? null : "import")}
            >
              Import
            </button>
          )}
        </div>
      </header>
      {!canEdit && (
        <p className="tile-hint">
          You have the {myRole} role in {report.data?.workspaceName || "this workspace"},
          so this report is read-only for you. Its data still runs on your own
          Snowflake credentials.
        </p>
      )}
      {moving && canEdit && <MovePanel reportId={reportId} onDone={() => setMoving(false)} />}
      {save.isError && (
        <p role="alert">
          {save.error instanceof ApiError ? save.error.message : "Could not save this report."}
        </p>
      )}
      {notice && <p className="notice">{notice}</p>}
      {needsBind ? (
        <BindViewPanel reason={view.name ? viewMissingReason(view) : null} onBind={bindView} />
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          {crossFilter && (
            // role="status" rather than a bare div: a filter applied by
            // clicking somewhere else has to be announced, not just drawn.
            <p className="cross-filter-chip" role="status">
              Filtered by {crossFilter.field} = {crossFilter.value}
              <button type="button" className="link" onClick={() => setCrossFilter(null)}>
                Clear cross-filter
              </button>
            </p>
          )}
          <div className="builder-body">
            <div className="canvas-column">
              <CanvasGrid
              visuals={activePage.visuals}
              canvas={definition.canvas}
              view={view}
              selectedId={selectedId}
              onSelect={selectVisual}
              onLayoutChange={onLayoutChange}
              reportFilters={definition.filters ?? []}
              pageFilters={activePage.filters ?? []}
              hierarchies={hierarchies}
              drill={drill}
              onDrill={(visualId, next) =>
                setDrill((current) => {
                  if (!next) {
                    const { [visualId]: _dropped, ...rest } = current;
                    return rest;
                  }
                  return { ...current, [visualId]: next };
                })
              }
              crossFilter={crossFilter}
              onCrossFilter={setCrossFilter}
              slicerSelections={slicerSelections}
              onSlicerChange={(field, values) =>
                setSlicerSelections((current) => {
                  // An emptied slicer drops its key rather than keeping an
                  // empty array, so "is anything sliced?" stays one check.
                  if (values.length === 0) {
                    const { [field]: _cleared, ...rest } = current;
                    return rest;
                  }
                  return { ...current, [field]: values };
                })
              }
            />
              <PageBar
                pages={definition.pages}
                activeId={activePage.id}
                canEdit={canEdit}
                onSelect={switchPage}
                onAdd={addPage}
                onRename={renamePage}
                onDuplicate={duplicatePage}
                onDelete={deletePage}
                onMove={movePage}
              />
            </div>
            <aside className="builder-rail">
              <Pane title="Filters" defaultCollapsed={startFiltersCollapsed}>
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
              <Pane title="Visualizations">
                <VisualPicker value={selectedType} onChange={onTypeChange} />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => addVisual(selectedType)}
                >
                  Add visual
                </button>
                {selected ? (
                  <VisualWells visual={selected} onChange={replaceVisual} />
                ) : (
                  <p className="tile-hint">Select a visual on the canvas to edit its fields.</p>
                )}
              </Pane>
              <Pane title="Data">
                <DataPane
                  dimensions={dimensions}
                  metrics={metrics}
                  selected={selected}
                  canEdit={canEdit}
                  onToggleField={toggleField}
                  renderRow={(field, kind) => (
                    <BuilderFieldRow field={field} kind={kind} onAdd={addFieldToSelected} />
                  )}
                  headerExtra={
                    <>
                      <button
                        type="button"
                        className="link"
                        onClick={() => refreshFields.mutate()}
                        disabled={refreshFields.isPending || !view.name}
                      >
                        {refreshFields.isPending ? "Refreshing…" : "Refresh fields"}
                      </button>
                      {refreshFields.isError && (
                        <p role="alert">
                          {refreshFields.error instanceof ApiError
                            ? refreshFields.error.message
                            : "Could not refresh fields."}
                        </p>
                      )}
                      {viewDetail.isError && !isMissingView(viewDetail.error) && (
                        <p role="alert">
                          {viewDetail.error instanceof ApiError
                            ? viewDetail.error.message
                            : "Could not describe this view."}
                        </p>
                      )}
                    </>
                  }
                  hierarchyRows={
                    hierarchies.length > 0 ? (
                      <section className="field-group">
                        <h4 className="field-group-title">Hierarchies</h4>
                        {hierarchies.map((h) => (
                          <BuilderHierarchyRow
                            key={h.id}
                            hierarchy={h}
                            onAdd={addFieldToSelected}
                          />
                        ))}
                      </section>
                    ) : null
                  }
                  footer={
                    <HierarchyPane
                      hierarchies={hierarchies}
                      dimensions={dimensions}
                      onChange={(next) =>
                        setDefinition({
                          ...definition,
                          // Model-declared hierarchies are not the report's to store.
                          hierarchies: next.filter((h) => !h.id.startsWith("model:")),
                        })
                      }
                    />
                  }
                />
              </Pane>
            </aside>
          </div>
        </DndContext>
      )}
      {panel === "export" && (
        <div className="panel-overlay">
          <ExportPanel reportId={reportId} onClose={() => setPanel(null)} />
        </div>
      )}
      {panel === "import" && (
        <div className="panel-overlay">
          <ImportPanel onImported={onImported} onClose={() => setPanel(null)} />
        </div>
      )}
      {exportExcel.isPending && (
        <p className="tile-hint">Running each visual's query on your connection…</p>
      )}
      {exportExcel.isError && (
        <p role="alert">
          {exportExcel.error instanceof ApiError
            ? exportExcel.error.message
            : "Could not export this report."}
        </p>
      )}
      {panel === "connect" && (
        <div className="panel-overlay">
          <ConnectPanel
            reportId={reportId}
            sheets={exportSheets()}
            onClose={() => setPanel(null)}
          />
        </div>
      )}
      {panel === "ask" && (
        <div className="panel-overlay">
          <AskPanel
            reportId={reportId}
            canEdit={canEdit}
            onAddVisual={addVisualFromSpec}
            onClose={() => setPanel(null)}
          />
        </div>
      )}
    </div>
  );
}
