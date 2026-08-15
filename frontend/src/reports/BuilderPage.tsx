import { DndContext, useDraggable, type DragEndEvent } from "@dnd-kit/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiFetch, ApiError } from "../api/client";
import { getReport, updateReport } from "../api/reports";
import type {
  FieldInfo,
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
import { CATALOG, defaultWellFor, emptyWellsFor, type FieldKind, type VisualType } from "./catalog";
import CanvasGrid from "./CanvasGrid";
import ExportPanel from "./ExportPanel";
import ImportPanel from "./ImportPanel";
import VisualPicker, { changeVisualType } from "./VisualPicker";
import VisualWells from "./VisualWells";

/** The describe call throws a real `ApiError` in production, but tests may
 *  reject with a plain `Error` carrying `code`/`status` (see
 *  BuilderPage.test.tsx's "offers to rebind" case) — so this checks shape
 *  rather than `instanceof ApiError`, which would miss that case. */
function isMissingView(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  const code = (error as { code?: unknown }).code;
  return status === 404 || code === "SNOWFLAKE_FORBIDDEN" || code === "QUERY_ERROR";
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
      <span className="field-ref">{ref}</span>
      {field.dataType && <small>{field.dataType}</small>}
    </button>
  );
}

function BuilderFieldGroup({
  title,
  kind,
  fields,
  onAdd,
}: {
  title: string;
  kind: FieldKind;
  fields: FieldInfo[];
  onAdd: (ref: string, kind: FieldKind) => void;
}) {
  return (
    <section className="field-group">
      <h4 className="field-group-title">{title}</h4>
      {fields.map((field) => (
        <BuilderFieldRow key={refOf(field)} field={field} kind={kind} onAdd={onAdd} />
      ))}
    </section>
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
  const [panel, setPanel] = useState<"export" | "import" | null>(null);

  useEffect(() => {
    if (report.data && definition === null) {
      setDefinition(report.data.definition);
      setSavedJson(JSON.stringify(report.data.definition));
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

  if (report.isLoading || definition === null) {
    return <p>Loading report…</p>;
  }
  if (report.isError) {
    return (
      <p role="alert">
        {report.error instanceof ApiError ? report.error.message : "Could not load this report."}
      </p>
    );
  }

  const dirty = JSON.stringify(definition) !== savedJson;
  const selected = definition.visuals.find((v) => v.id === selectedId) ?? null;
  const needsBind = !view.name || (viewDetail.isError && isMissingView(viewDetail.error));

  // Declared as `const ... = (...) => {}` (function expressions), not hoisted
  // `function` declarations, and placed after the `definition === null` guard
  // above: TypeScript only carries a narrowed type into a closure when the
  // closure is created after the check runs, which hoisted declarations
  // (visible before their narrowing point) don't qualify for. That's what
  // lets every reference to `definition` below stay typed as `ReportDefinition`
  // (not `| null`) without a non-null assertion.
  const replaceVisual = (next: Visual) => {
    setDefinition({
      ...definition,
      visuals: definition.visuals.map((v) => (v.id === next.id ? next : v)),
    });
  };

  const selectVisual = (visualId: string) => {
    setSelectedId(visualId);
    const visual = definition.visuals.find((v) => v.id === visualId);
    if (visual) setSelectedType(visual.type as VisualType);
  };

  const addVisual = (type: VisualType) => {
    const nextY = definition.visuals.reduce(
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
    };
    setDefinition({ ...definition, visuals: [...definition.visuals, visual] });
    setSelectedId(visual.id);
    setSelectedType(type);
  };

  const addFieldToSelected = (ref: string, kind: FieldKind) => {
    const visual = definition.visuals.find((v) => v.id === selectedId);
    if (!visual) return;
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

  const onDragEnd = (event: DragEndEvent) => {
    const visual = definition.visuals.find((v) => v.id === selectedId);
    const overId = String(event.over?.id ?? "");
    const data = event.active.data.current as { ref: string; kind: FieldKind } | undefined;
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
    setDefinition({
      ...definition,
      visuals: definition.visuals.map((v) => (next[v.id] ? { ...v, layout: next[v.id] } : v)),
    });
  };

  const onTypeChange = (nextType: VisualType) => {
    setSelectedType(nextType);
    const visual = definition.visuals.find((v) => v.id === selectedId);
    if (!visual) return;
    const { visual: updated, dropped } = changeVisualType(visual, nextType);
    replaceVisual(updated);
    setNotice(dropped.length ? `Cleared on type change: ${dropped.join(", ")}.` : null);
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

  return (
    <div className="builder">
      <header className="builder-head">
        <input
          aria-label="Report name"
          value={definition.name}
          onChange={(e) => setDefinition({ ...definition, name: e.target.value })}
        />
        <div className="builder-actions">
          <button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="secondary"
            aria-pressed={panel === "export"}
            onClick={() => setPanel(panel === "export" ? null : "export")}
          >
            Export
          </button>
          <button
            type="button"
            className="secondary"
            aria-pressed={panel === "import"}
            onClick={() => setPanel(panel === "import" ? null : "import")}
          >
            Import
          </button>
        </div>
      </header>
      {notice && <p className="notice">{notice}</p>}
      {needsBind ? (
        <BindViewPanel reason={view.name ? viewMissingReason(view) : null} onBind={bindView} />
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="builder-body">
            <CanvasGrid
              visuals={definition.visuals}
              canvas={definition.canvas}
              view={view}
              selectedId={selectedId}
              onSelect={selectVisual}
              onLayoutChange={onLayoutChange}
            />
            <aside className="builder-panes">
              <section>
                <h3>Visualizations</h3>
                <VisualPicker value={selectedType} onChange={onTypeChange} />
                <button type="button" className="secondary" onClick={() => addVisual(selectedType)}>
                  Add visual
                </button>
                {selected ? (
                  <VisualWells visual={selected} onChange={replaceVisual} />
                ) : (
                  <p className="tile-hint">Select a visual on the canvas to edit its fields.</p>
                )}
              </section>
              <section>
                <div className="fields-pane-head">
                  <h3>Fields</h3>
                  <button
                    type="button"
                    className="link"
                    onClick={() => refreshFields.mutate()}
                    disabled={refreshFields.isPending || !view.name}
                  >
                    {refreshFields.isPending ? "Refreshing…" : "Refresh fields"}
                  </button>
                </div>
                {viewDetail.isError && !isMissingView(viewDetail.error) && (
                  <p role="alert">
                    {viewDetail.error instanceof ApiError
                      ? viewDetail.error.message
                      : "Could not describe this view."}
                  </p>
                )}
                <BuilderFieldGroup
                  title="Dimensions"
                  kind="dimension"
                  fields={dimensions}
                  onAdd={addFieldToSelected}
                />
                <BuilderFieldGroup
                  title="Metrics"
                  kind="metric"
                  fields={metrics}
                  onAdd={addFieldToSelected}
                />
              </section>
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
    </div>
  );
}
