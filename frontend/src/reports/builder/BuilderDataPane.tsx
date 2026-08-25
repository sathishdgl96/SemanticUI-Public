import { ApiError } from "../../api/client";
import type { Hierarchy, Visual } from "../../api/types";
import type { FieldKind } from "../catalog";
import DataPane from "../DataPane";
import HierarchyPane from "../HierarchyPane";
import Pane from "../../shell/Pane";
import { useResizablePane } from "../../ui/useResizablePane";
import { BuilderFieldRow, BuilderHierarchyRow } from "./FieldRows";
import type { useViewFields } from "./useViewFields";
import { isMissingView } from "./viewBinding";

/** The Data pane wired for the builder: draggable field rows, the report's
 *  hierarchies offered like fields, hierarchy authoring in the footer, and
 *  the view's refresh button with its failure alerts. */
export default function BuilderDataPane({
  fields,
  viewName,
  selected,
  canEdit,
  onToggleField,
  onAddField,
  onHierarchiesChange,
}: {
  fields: ReturnType<typeof useViewFields>;
  viewName: string;
  selected: Visual | null;
  canEdit: boolean;
  onToggleField: (ref: string, kind: FieldKind, nextChecked: boolean) => void;
  onAddField: (ref: string, kind: FieldKind) => void;
  onHierarchiesChange: (next: Hierarchy[]) => void;
}) {
  const { dimensions, metrics, hierarchies, refreshFields, viewDetail } = fields;
  // A field list is where a long `SCHEMA.COLUMN_NAME` gets cut off, and
  // 232px is a guess about the reader's names. Their own width, on their
  // own machine (see useResizablePane on where it lives).
  const size = useResizablePane("builder.data.width", 232, "left");
  return (
    <Pane title="Data" resize={size}>
      <DataPane
        dimensions={dimensions}
        metrics={metrics}
        selected={selected}
        canEdit={canEdit}
        onToggleField={onToggleField}
        renderRow={(field, kind) => (
          <BuilderFieldRow field={field} kind={kind} onAdd={onAddField} />
        )}
        headerExtra={
          <>
            <button
              type="button"
              className="link"
              onClick={() => refreshFields.mutate()}
              disabled={refreshFields.isPending || !viewName}
            >
              {refreshFields.isPending ? "Refreshing…" : "Refresh fields"}
            </button>
            {refreshFields.isError && (
              <p role="alert">
                {refreshFields.error instanceof ApiError
                  ? refreshFields.error.message
                  : "Could not refresh fields."}
              </p>
            )}
            {viewDetail.isError && !isMissingView(viewDetail.error) && (
              <p role="alert">
                {viewDetail.error instanceof ApiError
                  ? viewDetail.error.message
                  : "Could not describe this view."}
              </p>
            )}
          </>
        }
        hierarchyRows={
          hierarchies.length > 0 ? (
            <section className="field-group">
              <h4 className="field-group-title">Hierarchies</h4>
              {hierarchies.map((h) => (
                <BuilderHierarchyRow key={h.id} hierarchy={h} onAdd={onAddField} />
              ))}
            </section>
          ) : null
        }
        footer={
          <HierarchyPane
            hierarchies={hierarchies}
            dimensions={dimensions}
            onChange={onHierarchiesChange}
          />
        }
      />
    </Pane>
  );
}
