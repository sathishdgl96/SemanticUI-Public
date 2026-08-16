/** Pick values of a dimension: one screenful, and a search box for the rest.
 *
 *  The one value picker in this product -- the filter editor and the slicer
 *  both use it, so "search" means the same thing wherever you are. It used to
 *  be a thousand checkboxes; a column of 150 000 customer names made the pane
 *  unusable and still could not show you the name you wanted, because it was
 *  not in the first thousand alphabetically.
 *
 *  The search runs on the SERVER (see useFieldValues), which is the whole
 *  point: filtering ten fetched values would only ever find what is already
 *  on screen.
 */

import { useId, useState } from "react";
import type { ViewRef } from "../api/types";
import { useDebounced, useFieldValues } from "./useFieldValues";

interface Props {
  view: ViewRef;
  field: string;
  selected: string[];
  onChange: (values: string[]) => void;
  /** False for a single-select slicer, where picking replaces rather than adds. */
  multi?: boolean;
  /** Groups the radios of a single-select picker. */
  groupName?: string;
}

export default function ValuePicker({
  view, field, selected, onChange, multi = true, groupName,
}: Props) {
  const [typed, setTyped] = useState("");
  const search = useDebounced(typed);
  const values = useFieldValues(view, field, { search });
  const searchId = useId();

  const options = values.data?.values ?? [];
  const more = values.data?.truncated ?? false;

  const toggle = (value: string, checked: boolean) => {
    if (!multi) {
      onChange(checked ? [value] : []);
      return;
    }
    onChange(checked ? [...selected, value] : selected.filter((v) => v !== value));
  };

  return (
    <div className="value-picker">
      {/* Chosen values are listed OUTSIDE the option list, because searching
          replaces that list: without this, typing would appear to discard
          what you had already ticked. */}
      {selected.length > 0 && (
        <ul className="value-chosen" aria-label={`Selected values for ${field}`}>
          {selected.map((value) => (
            <li key={value}>
              <button
                type="button"
                onClick={() => onChange(selected.filter((v) => v !== value))}
                aria-label={`Remove ${value}`}
              >
                {value}
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        id={searchId}
        className="filter-search"
        type="search"
        aria-label={`Search values for ${field}`}
        placeholder="Search values…"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
      />

      <div className="filter-values">
        {values.isLoading && <p className="tile-hint">Loading values…</p>}
        {values.isError && <p role="alert">Could not load values for this field.</p>}
        {options.map((value) => (
          <label key={value} className="filter-value">
            <input
              type={multi ? "checkbox" : "radio"}
              name={multi ? undefined : groupName}
              checked={selected.includes(value)}
              onChange={(e) => toggle(value, e.target.checked)}
            />
            {value}
          </label>
        ))}
        {!values.isLoading && options.length === 0 && (
          <p className="tile-hint">
            {typed ? `No values match "${typed}".` : "This field has no values."}
          </p>
        )}
        {more && (
          <p className="tile-hint">
            More values match. Keep typing to narrow the list.
          </p>
        )}
      </div>
    </div>
  );
}
