import type { FieldInfo, Filter, ViewRef } from "../api/types";
import { describeFilter } from "./filters";
import { useFieldValues } from "./useFieldValues";

export type FilterOp = Filter["op"];

const OP_LABEL: Record<FilterOp, string> = {
  is: "is",
  isNot: "is not",
  between: "is between",
  relativeDate: "in the last",
};

function isDate(dataType: string | null): boolean {
  const t = (dataType ?? "").toUpperCase();
  return t.startsWith("DATE") || t.startsWith("TIMESTAMP");
}

function isNumeric(dataType: string | null): boolean {
  const t = (dataType ?? "").toUpperCase();
  return (
    t.startsWith("NUMBER") ||
    t.startsWith("DECIMAL") ||
    t.startsWith("INT") ||
    t.startsWith("FLOAT") ||
    t.startsWith("DOUBLE") ||
    t.startsWith("REAL")
  );
}

/** Which operators make sense for a field of this type. Offering `between` on
 *  free text, or a relative-date window on a string, produces filters that are
 *  valid but meaningless. */
export function operatorsFor(dataType: string | null): FilterOp[] {
  if (isDate(dataType)) return ["is", "isNot", "between", "relativeDate"];
  if (isNumeric(dataType)) return ["is", "isNot", "between"];
  return ["is", "isNot"];
}

/** Rebuild the filter from scratch on an operator change.
 *
 *  Spreading the old filter would carry `values` into a `between` — a shape
 *  the backend's discriminated union rejects, since it forbids extra keys. */
function withOperator(filter: Filter, op: FilterOp): Filter {
  const base = { id: filter.id, field: filter.field };
  if (op === "is" || op === "isNot") return { ...base, op, values: [] };
  if (op === "between") return { ...base, op, from: "", to: "" };
  return { ...base, op, unit: "day", count: 30 };
}

interface Props {
  field: FieldInfo | null;
  filter: Filter;
  view: ViewRef;
  onChange: (next: Filter) => void;
  onRemove: () => void;
}

export default function FilterEditor({ field, filter, view, onChange, onRemove }: Props) {
  const operators = operatorsFor(field?.dataType ?? null);
  const wantsValues = filter.op === "is" || filter.op === "isNot";
  const values = useFieldValues(view, wantsValues ? filter.field : null);
  const chosen = wantsValues ? filter.values : [];

  const toggle = (value: string) => {
    if (filter.op !== "is" && filter.op !== "isNot") return;
    const next = chosen.includes(value)
      ? chosen.filter((v) => v !== value)
      : [...chosen, value];
    onChange({ ...filter, values: next });
  };

  return (
    <div className="filter-editor">
      <div className="filter-editor-head">
        {/* The summary, not just the field name: with two scopes on screen at
            once, "CUSTOMERS.REGION" alone does not say what it is doing. */}
        <span className="filter-field">{describeFilter(filter)}</span>
        <button type="button" className="link" onClick={onRemove}>
          Remove filter
        </button>
      </div>

      <label>
        Operator
        <select
          value={filter.op}
          onChange={(e) => onChange(withOperator(filter, e.target.value as FilterOp))}
        >
          {operators.map((op) => (
            <option key={op} value={op}>
              {OP_LABEL[op]}
            </option>
          ))}
        </select>
      </label>

      {wantsValues && (
        <div className="filter-values">
          {values.isLoading && <p className="tile-hint">Loading values…</p>}
          {values.isError && <p role="alert">Could not load values for this field.</p>}
          {values.data?.values.map((value) => (
            <label key={value} className="filter-value">
              <input
                type="checkbox"
                checked={chosen.includes(value)}
                onChange={() => toggle(value)}
              />
              {value}
            </label>
          ))}
          {values.data?.truncated && (
            <p className="tile-hint">
              Showing the first {values.data.values.length} values. This field has more
              than the picker can list.
            </p>
          )}
        </div>
      )}

      {filter.op === "between" && (
        <div className="filter-range">
          <label>
            From
            <input
              value={String(filter.from)}
              onChange={(e) => onChange({ ...filter, from: e.target.value })}
            />
          </label>
          <label>
            To
            <input
              value={String(filter.to)}
              onChange={(e) => onChange({ ...filter, to: e.target.value })}
            />
          </label>
        </div>
      )}

      {filter.op === "relativeDate" && (
        <div className="filter-relative">
          <label>
            Last
            <input
              type="number"
              min={1}
              value={filter.count ?? 30}
              onChange={(e) =>
                onChange({
                  id: filter.id,
                  field: filter.field,
                  op: "relativeDate",
                  unit: filter.unit ?? "day",
                  count: Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            Unit
            <select
              value={filter.unit ?? "day"}
              onChange={(e) =>
                onChange({
                  id: filter.id,
                  field: filter.field,
                  op: "relativeDate",
                  unit: e.target.value as "day" | "month" | "year",
                  count: filter.count ?? 30,
                })
              }
            >
              <option value="day">days</option>
              <option value="month">months</option>
              <option value="year">years</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
