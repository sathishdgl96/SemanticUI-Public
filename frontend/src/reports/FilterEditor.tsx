import { useState } from "react";
import type { FieldInfo, Filter, ViewRef } from "../api/types";
import { describeFilter, isActive, OPERATOR_LABEL } from "./filters";
import ValuePicker from "./ValuePicker";

export type FilterOp = Filter["op"];

/** Operators that take one free-typed value. */
const SINGLE_VALUE_OPS: FilterOp[] = [
  "contains", "notContains", "startsWith", "endsWith",
  "gt", "gte", "lt", "lte",
];

/** Operators that take no value at all. */
const NO_VALUE_OPS: FilterOp[] = ["isBlank", "isNotBlank"];

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
  // Presence tests apply to any type: a column of any kind can be empty.
  const blank: FilterOp[] = ["isBlank", "isNotBlank"];
  if (isDate(dataType)) {
    return [
      "is", "isNot",
      "between", "notBetween",
      "gt", "gte", "lt", "lte",
      "relativeDate",
      ...blank,
    ];
  }
  if (isNumeric(dataType)) {
    return ["is", "isNot", "between", "notBetween", "gt", "gte", "lt", "lte", ...blank];
  }
  // Text: substring matching, and lexical comparison is meaningless enough
  // on free text that offering it would invite wrong answers.
  return [
    "is", "isNot",
    "contains", "notContains", "startsWith", "endsWith",
    ...blank,
  ];
}

/** Rebuild the filter from scratch on an operator change.
 *
 *  Spreading the old filter would carry `values` into a `between` — a shape
 *  the backend's discriminated union rejects, since it forbids extra keys. */
function withOperator(filter: Filter, op: FilterOp): Filter {
  const base = { id: filter.id, field: filter.field };
  if (op === "is" || op === "isNot") return { ...base, op, values: [] };
  if (op === "between" || op === "notBetween") return { ...base, op, from: "", to: "" };
  if (op === "relativeDate") return { ...base, op, unit: "day", count: 30 };
  if (NO_VALUE_OPS.includes(op)) return { ...base, op } as Filter;
  // Text and comparison share one shape; carrying a value across the switch
  // would be a nicety, but the old value rarely means the same thing under a
  // new operator.
  return { ...base, op, value: "" } as Filter;
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
  const chosen = wantsValues ? filter.values : [];

  // A filter arrives open when it still needs input and closed once it is
  // doing something. Every card standing open at once is what made the pane
  // unusable: a dimension with a thousand values gave each card a 200px
  // scroller, and four filters buried the scopes below them.
  //
  // The picker below only mounts when the card is open, which is also what
  // keeps its Snowflake round trip from happening for a card nobody expanded.
  const [open, setOpen] = useState(() => !isActive(filter));

  return (
    <div className={open ? "filter-editor open" : "filter-editor"}>
      <div className="filter-editor-head">
        {/* The summary, not just the field name: with several scopes on screen
            at once, "CUSTOMERS.REGION" alone does not say what it is doing --
            and when the card is closed the summary IS the card. */}
        <button
          type="button"
          className="filter-toggle"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          <span className="filter-caret" aria-hidden="true">
            {open ? "⌄" : "›"}
          </span>
          <span className="filter-field">{describeFilter(filter)}</span>
        </button>
        {/* An icon, not the words: three filter cards stacked put "Remove
            filter" on screen three times, which read as the loudest thing in
            a pane whose subject is the filters. The name is still there for
            anyone who needs it -- as the accessible name and the tooltip. */}
        <button
          type="button"
          className="icon-button danger"
          onClick={onRemove}
          aria-label={`Remove filter on ${filter.field}`}
          title="Remove filter"
        >
          <span aria-hidden="true">🗑</span>
        </button>
      </div>

      {open && (
      <>
      <label>
        Operator
        <select
          value={filter.op}
          onChange={(e) => onChange(withOperator(filter, e.target.value as FilterOp))}
        >
          {operators.map((op) => (
            <option key={op} value={op}>
              {OPERATOR_LABEL[op]}
            </option>
          ))}
        </select>
      </label>

      {wantsValues && (
        <ValuePicker
          view={view}
          field={filter.field}
          selected={chosen}
          onChange={(next) => onChange({ ...filter, values: next } as Filter)}
        />
      )}

      {SINGLE_VALUE_OPS.includes(filter.op) && "value" in filter && (
        <label className="filter-single">
          Value
          <input
            value={String(filter.value)}
            // A number field for the ordered comparisons, text for the
            // substring ones -- the phone keyboard that appears is decided
            // by this and nothing else.
            type={filter.op.startsWith("g") || filter.op.startsWith("l") ? "number" : "text"}
            onChange={(e) => onChange({ ...filter, value: e.target.value })}
          />
        </label>
      )}

      {NO_VALUE_OPS.includes(filter.op) && (
        <p className="tile-hint">
          This operator needs no value: it tests whether the field is filled in.
        </p>
      )}

      {(filter.op === "between" || filter.op === "notBetween") && (
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
      </>
      )}
    </div>
  );
}
