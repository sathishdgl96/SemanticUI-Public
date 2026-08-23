import type { FieldInfo, Filter, ViewRef } from "../api/types";
import FilterEditor from "../reports/FilterEditor";
import { newFilterId } from "../reports/filters";

interface Props {
  view: ViewRef;
  fields: FieldInfo[];
  filters: Filter[];
  onChange: (next: Filter[]) => void;
}

function refOf(field: FieldInfo): string {
  return `${field.table}.${field.name}`;
}

/** The explore's filter bar — Looker's, in this product's vocabulary.
 *
 *  Deliberately built from the report's own FilterEditor rather than a
 *  second implementation: a filter should mean exactly one thing across
 *  this product, and two editors is how "contains" starts behaving
 *  differently depending on which screen you are on. */
export default function ExploreFilters({ view, fields, filters, onChange }: Props) {
  const used = new Set(filters.map((f) => f.field));
  const available = fields.filter((f) => !used.has(refOf(f)));

  const add = (ref: string) => {
    if (!ref) return;
    onChange([...filters, { id: newFilterId(), field: ref, op: "is", values: [] }]);
  };

  return (
    <section className="explore-filters">
      <h2 className="pane-heading">Filters</h2>
      {filters.length === 0 && (
        <p className="tile-hint">No filters. This explore returns everything.</p>
      )}
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
      <label className="filter-add" htmlFor="explore-add-filter">
        Add a filter
      </label>
      <select
        id="explore-add-filter"
        value=""
        onChange={(e) => add(e.target.value)}
        disabled={!available.length}
      >
        <option value="">Choose a field…</option>
        {available.map((field) => (
          <option key={refOf(field)} value={refOf(field)}>
            {refOf(field)}
          </option>
        ))}
      </select>
    </section>
  );
}
