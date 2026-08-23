export interface Facet {
  key: string;
  label: string;
}

/** Why the list is shorter than the whole, and how to undo it. A filter the
 *  reader cannot see is indistinguishable from missing data — which is the
 *  whole reason this is a chip rather than a mode. */
export function FacetChips({
  facets,
  onClear,
  shown,
  total,
}: {
  facets: Facet[];
  onClear: (key: string) => void;
  shown: number;
  total: number;
}) {
  if (facets.length === 0) return null;
  return (
    <div className="facets">
      <span className="facets-count">
        Showing {shown} of {total}
      </span>
      {facets.map((facet) => (
        <button
          key={facet.key}
          type="button"
          className="facet-chip"
          aria-label={`Clear ${facet.key}`}
          onClick={() => onClear(facet.key)}
        >
          <span className="facet-chip-label">{facet.label}</span>
          <span className="facet-chip-remove" aria-hidden="true">
            ✕
          </span>
        </button>
      ))}
    </div>
  );
}
