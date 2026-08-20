import type {
  Hierarchy,
  Page,
  ReportDefinition,
  SemanticViewDetail,
  ViewRef,
  VisualLayout,
} from "../../api/types";
import ModelTab from "../../model/ModelTab";
import CanvasGrid from "../CanvasGrid";
import PageBar from "../PageBar";
import SheetView from "../SheetView";
import * as pageOps from "./pageOps";
import type { BuilderInteraction } from "./useBuilderInteraction";

/** The page surface: a sheet's pivot or the canvas grid, with the page tabs
 *  underneath. Page operations are computed by pageOps and handed back via
 *  `onPageOp` so the definition state stays owned by the page component. */
export default function BuilderCanvasColumn({
  definition,
  activePage,
  view,
  hierarchies,
  factRefs,
  viewDetail,
  canEdit,
  ui,
  onSelect,
  onLayoutChange,
  onSwitchPage,
  onPageOp,
  onDeleteVisual,
  onPinVisual,
}: {
  definition: ReportDefinition;
  activePage: Page;
  view: ViewRef;
  hierarchies: Hierarchy[];
  factRefs: string[];
  viewDetail?: SemanticViewDetail;
  canEdit: boolean;
  ui: BuilderInteraction;
  onSelect: (visualId: string) => void;
  onLayoutChange: (next: Record<string, VisualLayout>) => void;
  onSwitchPage: (pageId: string) => void;
  onPageOp: (result: pageOps.PageOpResult) => void;
  onDeleteVisual?: (visualId: string) => void;
  onPinVisual?: (visualId: string) => void;
}) {
  // The model takes the whole surface: it is a different way of looking
  // at the same view, not something to squeeze beside the pages.
  if (ui.mode === "model") {
    return (
      <div className="canvas-column">
        <ModelTab detail={viewDetail} />
      </div>
    );
  }

  return (
    <div className="canvas-column">
      {activePage.kind === "sheet" ? (
        <SheetView
          visual={activePage.visuals[0] ?? null}
          view={view}
          reportFilters={definition.filters ?? []}
          pageFilters={activePage.filters ?? []}
          hierarchies={hierarchies}
          factRefs={factRefs}
        />
      ) : (
        <CanvasGrid
          visuals={activePage.visuals}
          canvas={definition.canvas}
          view={view}
          selectedId={ui.selectedId}
          onSelect={onSelect}
          onLayoutChange={onLayoutChange}
          reportFilters={definition.filters ?? []}
          pageFilters={activePage.filters ?? []}
          hierarchies={hierarchies}
          drill={ui.drill}
          onDrill={ui.onDrill}
          crossFilter={ui.crossFilter}
          onCrossFilter={ui.setCrossFilter}
          factRefs={factRefs}
          slicerSelections={ui.slicerSelections}
          onSlicerChange={ui.onSlicerChange}
          onDeleteVisual={onDeleteVisual}
          onPinVisual={onPinVisual}
        />
      )}
      <PageBar
        pages={definition.pages}
        activeId={activePage.id}
        canEdit={canEdit}
        onSelect={onSwitchPage}
        onAdd={() => onPageOp(pageOps.addPage(definition))}
        onAddSheet={() => onPageOp(pageOps.addSheet(definition))}
        onRename={(pageId, name) => onPageOp(pageOps.renamePage(definition, pageId, name))}
        onDuplicate={(pageId) => onPageOp(pageOps.duplicatePage(definition, pageId))}
        onDelete={(pageId) => onPageOp(pageOps.deletePage(definition, pageId, activePage.id))}
        onMove={(pageId, direction) => onPageOp(pageOps.movePage(definition, pageId, direction))}
      />
    </div>
  );
}
