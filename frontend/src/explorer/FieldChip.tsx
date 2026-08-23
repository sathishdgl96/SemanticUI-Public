import type { FieldKind, WellId } from "./wells";

interface Props {
  refName: string;
  kind: FieldKind;
  wellId: WellId;
  onRemove: (wellId: WellId, ref: string) => void;
}

export default function FieldChip({ refName, kind, wellId, onRemove }: Props) {
  return (
    <span className="chip" data-kind={kind}>
      <span className="chip-glyph">{kind === "metric" ? "Σ" : "⬦"}</span>
      <span className="chip-label">{refName}</span>
      <button
        type="button"
        className="chip-remove"
        aria-label={`Remove ${refName}`}
        onClick={() => onRemove(wellId, refName)}
      >
        &times;
      </button>
    </span>
  );
}
