import { useDroppable } from "@dnd-kit/core";
import type { FieldInfo, Filter, ViewRef } from "../api/types";
import FilterEditor from "./FilterEditor";
import { newFilterId } from "./filters";

/** Droppable ids. BuilderPage's `onDragEnd` matches on these, so they live
 *  here next to the components that register them. */
export const REPORT_DROP_ID = "filter:report";
export const PAGE_DROP_ID = "filter:page";
export const VISUAL_DROP_ID = "filter:visual";

interface Props {
  view: ViewRef;
  fields: FieldInfo[];
  /** The all-pages scope. */
  reportFilters: Filter[];
  /** The active page's own scope. */
  pageFilters: Filter[];
  /** null when no visual is selected — the visual scope is then hidden. */
  visualFilters: Filter[] | null;
  selectedVisualTitle: string | null;
  onChangeReport: (next: Filter[]) => void;
  onChangePage: (next: Filter[]) => void;
  onChangeVisual: (next: Filter[]) => void;
}

function refOf(field: FieldInfo): string {
  return `${field.table}.${field.name}`;
}

function FilterScope({
  heading,
  emptyText,
  addLabel,
  dropId,
  testId,
  filters,
  fields,
  view,
  onChange,
}: {
  heading: string;
  emptyText: string;
  addLabel: string;
  dropId: string;
  testId: string;
  filters: Filter[];
  fields: FieldInfo[];
  view: ViewRef;
  onChange: (next: Filter[]) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId });
  const filtered = new Set(filters.map((f) => f.field));
  const available = fields.filter((f) => !filtered.has(refOf(f)));

  const add = (ref: string) => {
    if (!ref) return;
    onChange([...filters, { id: newFilterId(), field: ref, op: "is", values: [] }]);
  };

  return (
    <div
      className={isOver ? "filter-scope over" : "filter-scope"}
      ref={setNodeRef}
      data-testid={testId}
    >
      <h4>{heading}</h4>
      {filters.length === 0 && <p className="tile-hint">{emptyText}</p>}
      {filters.map((filter, index) => (
        <FilterEditor
          key={filter.id}
          view={view}
          filter={filter}
          field={fields.find((f) => refOf(f) === filter.field) ?? null}
          onChange={(next) => onChange(filters.map((f, i) => (i === index ? next : f)))}
          onRemove={() => onChange(filters.filter((_, i) => i !== index))}
        />
      ))}
      <label className="filter-add">
        {addLabel}
        {/* This scope is also a drop target, but the select stays regardless:
            drag is never the only path to anything. */}
        <select value="" onChange={(e) => add(e.target.value)} disabled={!available.length}>
          <option value="">Choose a field…</option>
          {available.map((field) => (
            <option key={refOf(field)} value={refOf(field)}>
              {refOf(field)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export default function FilterPane({
  view,
  fields,
  reportFilters,
  pageFilters,
  visualFilters,
  selectedVisualTitle,
  onChangeReport,
  onChangePage,
  onChangeVisual,
}: Props) {
  // Narrowest scope first, widest last -- PowerBI's order, and the one that
  // reads as a sentence: this visual, then this page, then everywhere.
  return (
    <section className="filter-pane">
      <h3>Filters</h3>
      {visualFilters !== null && (
        <FilterScope
          heading={`Filters on "${selectedVisualTitle || "this visual"}"`}
          emptyText="No filters on this visual. It shows everything the page and report filters allow."
          addLabel="Add a filter on this visual"
          dropId={VISUAL_DROP_ID}
          testId="filter-drop-visual"
          filters={visualFilters}
          fields={fields}
          view={view}
          onChange={onChangeVisual}
        />
      )}
      <FilterScope
        heading="Filters on this page"
        emptyText="No filters on this page. Every visual shows all its data."
        addLabel="Add a filter on this page"
        dropId={PAGE_DROP_ID}
        testId="filter-drop-page"
        filters={pageFilters}
        fields={fields}
        view={view}
        onChange={onChangePage}
      />
      <FilterScope
        heading="Filters on all pages"
        emptyText="No filters across pages."
        addLabel="Add a filter on all pages"
        dropId={REPORT_DROP_ID}
        testId="filter-drop-report"
        filters={reportFilters}
        fields={fields}
        view={view}
        onChange={onChangeReport}
      />
    </section>
  );
}
