import type { FieldInfo, Visual } from "../../api/types";
import { CATALOG, type VisualType } from "../catalog";
import ColorField from "../ColorField";
import FormatPane from "../FormatPane";
import Pane from "../../shell/Pane";
import VisualPicker from "../VisualPicker";
import VisualWells from "../VisualWells";

/** PowerBI's Visualizations pane: pick a type (or the sheet's Matrix/Table
 *  toggle), then Build (what the visual shows) or Format (how it looks).
 *  With nothing selected it formats the PAGE — the canvas colour. */
export default function VisualizationsPane({
  isSheet,
  selected,
  selectedType,
  onTypeChange,
  onAddVisual,
  paneTab,
  onPaneTab,
  onChangeVisual,
  factRefs,
  fields,
  canvasBackground,
  onCanvasBackground,
}: {
  isSheet: boolean;
  selected: Visual | null;
  selectedType: VisualType;
  onTypeChange: (type: VisualType) => void;
  onAddVisual: () => void;
  paneTab: "build" | "format";
  onPaneTab: (tab: "build" | "format") => void;
  onChangeVisual: (visual: Visual) => void;
  factRefs: string[];
  fields: FieldInfo[];
  canvasBackground: string | null | undefined;
  onCanvasBackground: (hex: string | null) => void;
}) {
  return (
    <Pane title="Visualizations">
      {isSheet ? (
        <div className="pane-tabs" role="tablist" aria-label="Pivot style">
          {(["matrix", "table"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={selected?.type === t}
              className={selected?.type === t ? "pane-tab active" : "pane-tab"}
              onClick={() => onTypeChange(t)}
            >
              {CATALOG[t].label}
            </button>
          ))}
        </div>
      ) : (
        <>
          <VisualPicker value={selectedType} onChange={onTypeChange} />
          <button type="button" className="secondary" onClick={onAddVisual}>
            Add visual
          </button>
        </>
      )}
      {selected ? (
        <>
          {/* Build is what the visual SHOWS, Format is how it LOOKS --
              PowerBI's split, and the reason the two do not compete for the
              same strip of pane. */}
          <div className="pane-tabs" role="tablist" aria-label="Visual settings">
            <button
              type="button"
              role="tab"
              aria-selected={paneTab === "build"}
              className={paneTab === "build" ? "pane-tab active" : "pane-tab"}
              onClick={() => onPaneTab("build")}
            >
              Build
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={paneTab === "format"}
              className={paneTab === "format" ? "pane-tab active" : "pane-tab"}
              onClick={() => onPaneTab("format")}
            >
              Format
            </button>
          </div>
          {paneTab === "build" ? (
            <VisualWells visual={selected} onChange={onChangeVisual} factRefs={factRefs} />
          ) : (
            <FormatPane visual={selected} onChange={onChangeVisual} fields={fields} />
          )}
        </>
      ) : (
        // PowerBI's behaviour: nothing selected means you are formatting the
        // PAGE. The canvas colour is the only report-level thing to set
        // today, and it needs somewhere to live that is not a per-visual
        // pane.
        <section className="format-section">
          <h4>Canvas</h4>
          <ColorField
            label="Background"
            value={canvasBackground ?? ""}
            fallback="#f5f5f5"
            onChange={(hex) => onCanvasBackground(hex ?? null)}
          />
          <p className="tile-hint">
            Select a visual on the canvas to edit its fields and its own
            formatting.
          </p>
        </section>
      )}
    </Pane>
  );
}
