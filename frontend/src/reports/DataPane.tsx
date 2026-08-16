import { useId, useMemo, useState } from "react";
import type { FieldInfo, Visual } from "../api/types";
import type { FieldKind } from "./catalog";

interface Props {
  dimensions: FieldInfo[];
  metrics: FieldInfo[];
  selected: Visual | null;
  canEdit: boolean;
  /** Checkbox semantics, PowerBI's: check adds the field to the selected
   *  visual (the page creates one first if none is selected); uncheck removes
   *  it from whichever well holds it. */
  onToggleField: (ref: string, kind: FieldKind, nextChecked: boolean) => void;
  /** The existing draggable field row, supplied by the page so drag-and-drop
   *  and click-to-add keep working exactly as before. */
  renderRow: (field: FieldInfo, kind: FieldKind) => React.ReactNode;
  /** The Refresh fields control and its error, rendered in the pane header row. */
  headerExtra?: React.ReactNode;
  /** Placeable hierarchy rows, shown as their own group among the fields. */
  hierarchyRows?: React.ReactNode;
  /** The hierarchy editor, collapsible at the bottom of the pane. */
  footer?: React.ReactNode;
}

function refOf(field: FieldInfo): string {
  return `${field.table}.${field.name}`;
}

function isChecked(selected: Visual | null, ref: string): boolean {
  if (!selected) return false;
  return Object.values(selected.wells).some((refs) => refs.includes(ref));
}

/** The PowerBI Data pane: search, fields grouped by table, checkboxes. */
export default function DataPane({
  dimensions,
  metrics,
  selected,
  canEdit,
  onToggleField,
  renderRow,
  headerExtra,
  hierarchyRows,
  footer,
}: Props) {
  const searchId = useId();
  const [search, setSearch] = useState("");
  const [closedTables, setClosedTables] = useState<Set<string>>(new Set());

  const tables = useMemo(() => {
    const needle = search.trim().toUpperCase();
    const matches = (field: FieldInfo) =>
      !needle || refOf(field).toUpperCase().includes(needle);

    const grouped = new Map<string, { dims: FieldInfo[]; mets: FieldInfo[] }>();
    for (const field of dimensions) {
      if (!matches(field)) continue;
      const entry = grouped.get(field.table) ?? { dims: [], mets: [] };
      entry.dims.push(field);
      grouped.set(field.table, entry);
    }
    for (const field of metrics) {
      if (!matches(field)) continue;
      const entry = grouped.get(field.table) ?? { dims: [], mets: [] };
      entry.mets.push(field);
      grouped.set(field.table, entry);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [dimensions, metrics, search]);

  const toggleTable = (table: string) => {
    setClosedTables((current) => {
      const next = new Set(current);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });
  };

  const row = (field: FieldInfo, kind: FieldKind) => {
    const ref = refOf(field);
    return (
      <div className="data-row" key={`${kind}:${ref}`}>
        <input
          type="checkbox"
          className="data-check"
          aria-label={ref}
          checked={isChecked(selected, ref)}
          disabled={!canEdit}
          onChange={(e) => onToggleField(ref, kind, e.target.checked)}
        />
        {renderRow(field, kind)}
      </div>
    );
  };

  return (
    <div className="data-pane">
      <div className="data-pane-head">{headerExtra}</div>
      <input
        id={searchId}
        type="search"
        className="data-search"
        aria-label="Search fields"
        placeholder="Search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {tables.length === 0 && (
        <p className="tile-hint">
          {search ? "No fields match your search." : "Bind a semantic view to see its fields."}
        </p>
      )}

      {tables.map(([table, { dims, mets }]) => {
        const open = !closedTables.has(table);
        return (
          <div className="data-table" key={table}>
            <button
              type="button"
              className="data-table-head"
              aria-expanded={open}
              onClick={() => toggleTable(table)}
            >
              <span className="data-chevron" aria-hidden="true">
                {open ? "▾" : "▸"}
              </span>
              {table}
            </button>
            {open && (
              <div className="data-table-body">
                {dims.map((field) => row(field, "dimension"))}
                {mets.map((field) => row(field, "metric"))}
              </div>
            )}
          </div>
        );
      })}

      {hierarchyRows}
      {footer}
    </div>
  );
}
