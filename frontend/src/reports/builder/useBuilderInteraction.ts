import { useEffect, useState } from "react";
import type { VisualType } from "../catalog";
import type { CrossFilter, DrillState } from "../filters";

export type PanelKind = "export" | "import" | "ask" | "connect" | null;

/** Everything ephemeral about a builder session. None of it is ever written
 *  to the definition, so a saved report always opens at the top level, on
 *  its first page, with nothing selected — and can never point at a value
 *  that has since disappeared from the view. A viewer who cannot save can
 *  still drill, slice and cross-filter a shared report. */
export function useBuilderInteraction(reportId: string) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<VisualType>("bar");
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelKind>(null);
  // Which surface the canvas shows. Ephemeral like the rest: a saved
  // report always opens on its pages, and looking at the model never
  // changes the document.
  const [mode, setMode] = useState<"report" | "model">("report");
  const [drill, setDrill] = useState<Record<string, DrillState>>({});
  const [crossFilter, setCrossFilter] = useState<CrossFilter | null>(null);
  // Slicer ticks, keyed by field ref.
  const [slicerSelections, setSlicerSelections] = useState<Record<string, string[]>>({});
  const [moving, setMoving] = useState(false);
  // Which page tab is open. Ephemeral like the selection: a saved report
  // always opens on its first page.
  const [activePageId, setActivePageId] = useState<string | null>(null);
  // PowerBI's Build / Format toggle on the Visualizations pane.
  const [paneTab, setPaneTab] = useState<"build" | "format">("build");
  // On narrower desktops PowerBI shows two panes open; Filters starts tucked
  // away. Guarded: jsdom has no matchMedia.
  const [startFiltersCollapsed] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 1279px)").matches,
  );

  // Everything scoped to "the report currently being edited" resets when the
  // route swaps reports under this same component instance (the route
  // element isn't keyed — see useReportDocument's reset for the full story):
  // a stale `notice` from the old report would otherwise keep rendering
  // under the new one, and an open Export/Import `panel` should not silently
  // carry over.
  useEffect(() => {
    setSelectedId(null);
    setActivePageId(null);
    setNotice(null);
    setMode("report");
    setPanel(null);
    setDrill({});
    setCrossFilter(null);
    setSlicerSelections({});
    setMoving(false);
  }, [reportId]);

  /** Selection and cross-filter are page-local, as they are in PowerBI: a
   *  selection on one page must not keep constraining another. */
  const focusPage = (id: string) => {
    setActivePageId(id);
    setSelectedId(null);
    setCrossFilter(null);
    // Slicers live on a page too, so their ticks leave with it.
    setSlicerSelections({});
  };

  const onDrill = (visualId: string, next: DrillState | null | undefined) =>
    setDrill((current) => {
      if (!next) {
        const { [visualId]: _dropped, ...rest } = current;
        return rest;
      }
      return { ...current, [visualId]: next };
    });

  const onSlicerChange = (field: string, values: string[]) =>
    setSlicerSelections((current) => {
      // An emptied slicer drops its key rather than keeping an empty array,
      // so "is anything sliced?" stays one check.
      if (values.length === 0) {
        const { [field]: _cleared, ...rest } = current;
        return rest;
      }
      return { ...current, [field]: values };
    });

  return {
    selectedId, setSelectedId,
    selectedType, setSelectedType,
    notice, setNotice,
    panel, setPanel,
    mode, setMode,
    drill, onDrill,
    crossFilter, setCrossFilter,
    slicerSelections, onSlicerChange,
    moving, setMoving,
    activePageId,
    paneTab, setPaneTab,
    startFiltersCollapsed,
    focusPage,
  };
}

export type BuilderInteraction = ReturnType<typeof useBuilderInteraction>;
