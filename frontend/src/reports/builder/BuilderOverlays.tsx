import type { AskSpec, ReportDetail, SheetRequest } from "../../api/types";
import ChatPanel from "../../ask/ChatPanel";
import ConnectPanel from "../../export/ConnectPanel";
import ExportPanel from "../ExportPanel";
import ImportPanel from "../ImportPanel";
import type { PanelKind } from "./useBuilderInteraction";

/** The builder's overlays, one open at a time, plus the Excel export's
 *  progress and failure lines (they render whether or not a panel is open). */
export default function BuilderOverlays({
  panel,
  onClose,
  reportId,
  onImported,
  exportPending,
  exportError,
  connectSheets,
  feedVisuals,
  canEdit,
  onAddVisual,
}: {
  panel: PanelKind;
  onClose: () => void;
  reportId: string;
  onImported: (imported: ReportDetail) => void;
  exportPending: boolean;
  exportError: string | null;
  /** Called only while the Connect panel is open, so closed reports never
   *  pay for building the sheet requests. */
  connectSheets: () => SheetRequest[];
  feedVisuals: { id: string; title: string }[];
  canEdit: boolean;
  onAddVisual: (spec: AskSpec) => void;
}) {
  return (
    <>
      {panel === "export" && (
        <div className="panel-overlay">
          <ExportPanel reportId={reportId} onClose={onClose} />
        </div>
      )}
      {panel === "import" && (
        <div className="panel-overlay">
          <ImportPanel onImported={onImported} onClose={onClose} />
        </div>
      )}
      {exportPending && (
        <p className="tile-hint">Running each visual's query on your connection…</p>
      )}
      {exportError && <p role="alert">{exportError}</p>}
      {panel === "connect" && (
        <div className="panel-overlay">
          <ConnectPanel
            reportId={reportId}
            sheets={connectSheets()}
            feedVisuals={feedVisuals}
            onClose={onClose}
          />
        </div>
      )}
      {/* NOT in a panel-overlay: a chat you consult while reading a report
          cannot be a modal that hides the report. It floats in the corner,
          the way a support chat does, and can be resized because the useful
          size for "what was the answer" and for "show me the table" are not
          the same size. */}
      {panel === "ask" && (
        <ChatPanel
          reportId={reportId}
          canEdit={canEdit}
          onAddVisual={onAddVisual}
          onClose={onClose}
        />
      )}
    </>
  );
}
