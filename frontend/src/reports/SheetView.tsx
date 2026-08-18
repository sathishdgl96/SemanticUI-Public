import type { Filter, Hierarchy, ViewRef, Visual } from "../api/types";
import VisualTile from "./VisualTile";

interface Props {
  visual: Visual | null;
  view: ViewRef;
  reportFilters: Filter[];
  pageFilters: Filter[];
  hierarchies: Hierarchy[];
  factRefs: string[];
}

/** A sheet page: one pivot, the whole page, like a worksheet holding a
 *  PivotTable. There is no grid and nothing to drag -- the Data pane and the
 *  wells are the whole editing surface, exactly Excel's field-list model.
 *  Every filter scope still applies: report, page, and the pivot's own. */
export default function SheetView({
  visual,
  view,
  reportFilters,
  pageFilters,
  hierarchies,
  factRefs,
}: Props) {
  if (!visual) {
    return (
      <div className="canvas empty sheet">
        <p className="tile-hint">This sheet lost its pivot; delete the page.</p>
      </div>
    );
  }
  const empty =
    (visual.wells.rows ?? []).length === 0 &&
    (visual.wells.columns ?? []).length === 0 &&
    (visual.wells.values ?? []).length === 0 &&
    (visual.wells.dimensions ?? []).length === 0 &&
    (visual.wells.metrics ?? []).length === 0;
  return (
    <div className="canvas sheet">
      {empty ? (
        <p className="tile-hint">
          Tick fields in the Data pane — dimensions land in Rows and metrics
          in Values, and the pivot builds as you go, like an Excel PivotTable.
        </p>
      ) : (
        <div className="sheet-tile">
          <VisualTile
            visual={visual}
            view={view}
            selected
            onSelect={() => {}}
            reportFilters={reportFilters}
            pageFilters={pageFilters}
            hierarchies={hierarchies}
            factRefs={factRefs}
          />
        </div>
      )}
    </div>
  );
}
