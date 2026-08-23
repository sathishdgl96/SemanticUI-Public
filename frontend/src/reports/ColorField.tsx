/** A colour, pickable or typed as hex.
 *
 *  Both, because the two are different jobs: a swatch is how you choose a
 *  colour you are looking for, and a hex box is how you match a brand palette
 *  someone handed you on a slide. Offering only the picker is what makes a
 *  product feel like it cannot be made to look like your company's.
 *
 *  Only well-formed hex is emitted. These values end up in a `style`
 *  attribute and in an ECharts option, and the server -- which validates its
 *  own colour fields against the same shape -- should never be sent something
 *  it will reject.
 */

import { useEffect, useId, useState } from "react";

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHex(value: string): boolean {
  return HEX.test(value);
}

interface Props {
  label: string;
  /** The current colour, or "" for "not set". */
  value: string;
  /** What the swatch shows while nothing is set. */
  fallback: string;
  onChange: (hex: string | undefined) => void;
}

export default function ColorField({ label, value, fallback, onChange }: Props) {
  const id = useId();
  const [typed, setTyped] = useState(value);

  // Follows the visual when the selection changes underneath it -- otherwise
  // the box keeps showing the previous tile's colour.
  useEffect(() => setTyped(value), [value]);

  const commit = (next: string) => {
    setTyped(next);
    if (next === "") onChange(undefined);
    else if (isHex(next)) onChange(next);
    // Anything else is a half-typed "#0b0" on the way to "#0b0b0b": kept in
    // the box, not written to the document.
  };

  return (
    <>
      <label className="format-field" htmlFor={id}>
        {label}
      </label>
      <span className="color-field">
        <input
          type="color"
          aria-label={`${label} swatch`}
          value={isHex(typed) ? typed : fallback}
          onChange={(e) => commit(e.target.value)}
        />
        <input
          id={id}
          value={typed}
          placeholder={fallback}
          spellCheck={false}
          aria-invalid={typed !== "" && !isHex(typed)}
          onChange={(e) => commit(e.target.value.trim())}
        />
        {typed !== "" && (
          <button
            type="button"
            className="link"
            onClick={() => commit("")}
            aria-label={`Reset ${label}`}
          >
            Reset
          </button>
        )}
      </span>
    </>
  );
}
