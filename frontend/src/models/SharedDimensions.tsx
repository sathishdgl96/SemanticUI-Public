import { useState } from "react";
import type {
  Binding,
  CompositeMember,
  SharedDimension,
} from "../api/composites";
import type { SemanticViewDetail } from "../api/types";
import Icon from "../ui/Icon";
import {
  dimensionColumns,
  dimensionTables,
  suggestSharedDimensions,
} from "./matching";

/** A candidate's identity, so dismissing one is remembered across the
 *  re-suggestion that follows every edit. */
function signature(candidate: { bindings: Record<string, Binding> }): string {
  return Object.entries(candidate.bindings)
    .map(([alias, b]) => `${alias}.${b.table}.${b.column}`)
    .sort()
    .join("|");
}

/**
 * The conformed dimensions: which column in each view means the same
 * thing.
 *
 * Columns come from each view's own describe, so the table and column
 * fields are dropdowns rather than free text — a mistyped column saved
 * fine and failed at query time, which is a slow way to find a typo.
 *
 * Matching columns are *offered*, never applied. Two views having a
 * `CUSTOMER_ID` is evidence, not proof, and a mapping the app created by
 * itself is one nobody reviewed. What the suggestion saves is the typing.
 */
export default function SharedDimensions({
  members,
  describes,
  sharedDimensions,
  readOnly,
  loading,
  unreadable,
  onChange,
}: {
  members: CompositeMember[];
  describes: Record<string, SemanticViewDetail | undefined>;
  sharedDimensions: SharedDimension[];
  readOnly: boolean;
  loading: boolean;
  unreadable: string[];
  onChange: (next: SharedDimension[]) => void;
}) {
  const [dismissed, setDismissed] = useState<string[]>([]);

  const suggestions = suggestSharedDimensions(
    members,
    describes,
    sharedDimensions,
  ).filter((candidate) => !dismissed.includes(signature(candidate)));

  function patch(index: number, next: Partial<SharedDimension>) {
    onChange(
      sharedDimensions.map((shared, i) =>
        i === index ? { ...shared, ...next } : shared,
      ),
    );
  }

  function setBinding(index: number, alias: string, binding: Binding) {
    patch(index, {
      bindings: { ...sharedDimensions[index].bindings, [alias]: binding },
    });
  }

  function add(shared: SharedDimension) {
    onChange([...sharedDimensions, shared]);
  }

  return (
    <section className="model-section">
      <h3>What means the same thing</h3>
      <p className="tile-hint">
        The columns that let these views be asked one question. Matches are
        suggested from each view's own field list — confirm the ones that
        really are the same thing, because two views spelling something the
        same way is evidence, not proof.
      </p>

      {unreadable.length > 0 && (
        <p role="alert">
          Could not read the fields of {unreadable.join(", ")}. Snowflake
          decides what you can see, so those views offer no columns here.
        </p>
      )}

      {suggestions.length > 0 && (
        <div className="model-suggestions">
          <div className="model-suggestions-head">
            <strong>Matching columns found</strong>
            <button
              type="button"
              className="link"
              disabled={readOnly}
              onClick={() => {
                // Every one at once, for the common case where a model is
                // built over views that already conform.
                onChange([
                  ...sharedDimensions,
                  ...suggestions.map((candidate) => ({
                    name: candidate.name,
                    bindings: candidate.bindings,
                  })),
                ]);
              }}
            >
              Add all {suggestions.length}
            </button>
          </div>
          <ul className="model-suggestion-list">
            {suggestions.map((candidate) => (
              <li key={signature(candidate)}>
                <span className="model-suggestion-name">{candidate.name}</span>
                <span className="model-suggestion-why">{candidate.reason}</span>
                <code className="model-suggestion-cols">
                  {Object.entries(candidate.bindings)
                    .map(([alias, b]) => `${alias}: ${b.table}.${b.column}`)
                    .join("  ·  ")}
                </code>
                <span className="row-actions">
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() =>
                      add({ name: candidate.name, bindings: candidate.bindings })
                    }
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      setDismissed((current) => [...current, signature(candidate)])
                    }
                  >
                    Not the same
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading && sharedDimensions.length === 0 && (
        <p className="tile-hint">Reading the views' fields…</p>
      )}

      {sharedDimensions.map((shared, index) => (
        <div className="model-shared" key={index}>
          <div className="model-shared-head">
            <label className="sr-only" htmlFor={`shared-${index}`}>
              What to call it
            </label>
            <input
              id={`shared-${index}`}
              placeholder="Customer"
              value={shared.name}
              disabled={readOnly}
              onChange={(event) => patch(index, { name: event.target.value })}
            />
            <button
              type="button"
              className="icon-button danger"
              aria-label={`Remove ${shared.name || "this dimension"}`}
              disabled={readOnly}
              onClick={() =>
                onChange(sharedDimensions.filter((_, i) => i !== index))
              }
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
          <table className="content-table">
            <thead>
              <tr>
                <th>View</th>
                <th>Table</th>
                <th>Key column</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const detail = describes[member.alias.toLowerCase()];
                const binding = shared.bindings[member.alias];
                const tables = dimensionTables(detail);
                const columns = dimensionColumns(detail, binding?.table ?? "");
                return (
                  <tr key={member.alias}>
                    <td>{member.alias}</td>
                    <td>
                      <select
                        aria-label={`Table for ${member.alias}`}
                        value={binding?.table ?? ""}
                        disabled={readOnly || tables.length === 0}
                        onChange={(event) =>
                          // Changing the table invalidates the column: a
                          // column kept from the previous table would be
                          // a binding that cannot resolve.
                          setBinding(index, member.alias, {
                            table: event.target.value,
                            column: "",
                          })
                        }
                      >
                        <option value="">
                          {tables.length === 0 ? "No fields readable" : "Choose…"}
                        </option>
                        {/* A binding that was saved before the view changed
                            still shows, rather than silently resetting. */}
                        {binding?.table && !tables.includes(binding.table) && (
                          <option value={binding.table}>
                            {binding.table} (not in this view)
                          </option>
                        )}
                        {tables.map((table) => (
                          <option key={table} value={table}>
                            {table}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        aria-label={`Column for ${member.alias}`}
                        value={binding?.column ?? ""}
                        disabled={readOnly || !binding?.table}
                        onChange={(event) =>
                          setBinding(index, member.alias, {
                            table: binding?.table ?? "",
                            column: event.target.value,
                          })
                        }
                      >
                        <option value="">Choose…</option>
                        {binding?.column && !columns.includes(binding.column) && (
                          <option value={binding.column}>
                            {binding.column} (not in this table)
                          </option>
                        )}
                        {columns.map((column) => (
                          <option key={column} value={column}>
                            {column}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      <button
        type="button"
        disabled={readOnly || members.length < 2}
        onClick={() =>
          add({
            name: "",
            bindings: Object.fromEntries(
              members.map((member) => [member.alias, { table: "", column: "" }]),
            ),
          })
        }
        title={
          members.length < 2
            ? "Add a second view first — there is nothing to line up yet."
            : undefined
        }
      >
        Add one by hand
      </button>
    </section>
  );
}
