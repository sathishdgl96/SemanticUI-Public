import { useCallback, useEffect, useState } from "react";
import type { SemanticViewDetail } from "../api/types";
import FieldRelations from "./FieldRelations";
import ModelDiagram from "./ModelDiagram";
import TableDetail from "./TableDetail";

/** A table's card, or one column inside it. */
type Selection =
  | { kind: "table"; table: string }
  | { kind: "field"; ref: string }
  | null;

/** The model view of a report's bound semantic view.
 *
 *  Read-only by design: changing a model is DDL, which this app never
 *  issues (ADR 0001). */
export default function ModelTab({ detail }: { detail?: SemanticViewDetail }) {
  const [selection, setSelection] = useState<Selection>(null);

  // A selection names a table or a field, neither of which survives into a
  // different view.
  useEffect(() => {
    setSelection(null);
  }, [detail]);

  const selectField = useCallback((ref: string) => {
    setSelection((current) =>
      current?.kind === "field" && current.ref === ref ? null : { kind: "field", ref },
    );
  }, []);

  const selectTable = useCallback((table: string) => {
    setSelection((current) =>
      current?.kind === "table" && current.table === table
        ? null
        : { kind: "table", table },
    );
  }, []);

  const clear = useCallback(() => setSelection(null), []);

  if (!detail) {
    return <p className="tile-hint">Bind this report to a view to see its model.</p>;
  }

  const selectedRef = selection?.kind === "field" ? selection.ref : null;
  // A selected field highlights its own table too, so the card reads as
  // the origin of what the panel is describing.
  const selectedTable =
    selection?.kind === "table"
      ? selection.table
      : selectedRef
        ? selectedRef.split(".")[0]
        : null;

  return (
    <div className="model-tab">
      <ModelDiagram
        detail={detail}
        selectedRef={selectedRef}
        selectedTable={selectedTable}
        onSelectField={selectField}
        onSelectTable={selectTable}
      />
      {selection?.kind === "field" ? (
        <FieldRelations
          detail={detail}
          field={selection.ref}
          onSelect={selectField}
          onClear={clear}
        />
      ) : (
        <TableDetail
          detail={detail}
          table={selection?.kind === "table" ? selection.table : null}
          onSelectField={selectField}
        />
      )}
    </div>
  );
}
