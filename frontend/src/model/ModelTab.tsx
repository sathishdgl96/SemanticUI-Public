import { useEffect, useState } from "react";
import type { SemanticViewDetail } from "../api/types";
import ModelDiagram from "./ModelDiagram";
import TableDetail from "./TableDetail";

/** The model view of a report's bound semantic view.
 *
 *  Read-only by design: changing a model is DDL, which this app never
 *  issues (ADR 0001). */
export default function ModelTab({ detail }: { detail?: SemanticViewDetail }) {
  const [selected, setSelected] = useState<string | null>(null);

  // A selection is a table NAME, so without this it would survive into a
  // different view that has no such table.
  useEffect(() => {
    setSelected(null);
  }, [detail]);

  if (!detail) {
    return (
      <p className="tile-hint">Bind this report to a view to see its model.</p>
    );
  }

  return (
    <div className="model-tab">
      <ModelDiagram detail={detail} selected={selected} onSelect={setSelected} />
      <TableDetail detail={detail} table={selected} />
    </div>
  );
}
