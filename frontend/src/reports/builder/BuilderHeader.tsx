import Icon from "../../ui/Icon";
import { UNBOUND_HINT } from "./viewBinding";
import type { PanelKind } from "./useBuilderInteraction";

/** The command bar: report name, Save/Move, and the panel toggles. Pure
 *  presentation — every decision (dirtiness, roles, which panel is open)
 *  arrives as a prop.
 *
 *  One filled button and the rest quiet, which is the whole hierarchy:
 *  Save is the only command that changes the report, so it is the only one
 *  wearing a colour. Six outlined buttons in a row read as six separate
 *  decisions; ghost commands read as one bar. Each icon is decorative and
 *  hidden from the accessible name -- the label is the name. */
export default function BuilderHeader({
  name,
  onRename,
  canEdit,
  dirty,
  saving,
  onSave,
  moving,
  onToggleMove,
  panel,
  onTogglePanel,
  mode,
  onSetMode,
  viewName,
  exporting,
  onExportExcel,
}: {
  name: string;
  onRename: (name: string) => void;
  canEdit: boolean;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  moving: boolean;
  onToggleMove: () => void;
  panel: PanelKind;
  onTogglePanel: (panel: Exclude<PanelKind, null>) => void;
  mode: "report" | "model";
  onSetMode: (mode: "report" | "model") => void;
  viewName: string;
  exporting: boolean;
  onExportExcel: () => void;
}) {
  return (
    <header className="builder-head command-bar">
      <input
        className="report-title"
        aria-label="Report name"
        value={name}
        onChange={(e) => onRename(e.target.value)}
      />
      <div className="builder-actions">
        <button
          className="cmd-primary"
          onClick={onSave}
          disabled={!canEdit || !dirty || saving}
          title={dirty ? "Save changes" : "No unsaved changes"}
        >
          <Icon name="save" />
          {saving ? "Saving…" : "Save"}
        </button>
        {canEdit && (
          <button type="button" className="cmd" aria-pressed={moving} onClick={onToggleMove}>
            <Icon name="move" />
            Move
          </button>
        )}
        <span className="cmd-sep" aria-hidden="true" />
        {/* A view switch rather than a panel: a model diagram needs the
            whole canvas, and looking at it changes nothing about the
            report -- so it is a way of looking, not saved state. */}
        <div className="mode-switch" role="group" aria-label="Report or model">
          <button
            type="button"
            aria-pressed={mode === "report"}
            onClick={() => onSetMode("report")}
          >
            <Icon name="report" size={14} />
            Report
          </button>
          <button
            type="button"
            aria-pressed={mode === "model"}
            disabled={!viewName}
            title={viewName ? "See this view's tables and joins" : UNBOUND_HINT}
            onClick={() => onSetMode("model")}
          >
            <Icon name="model" size={14} />
            Model
          </button>
        </div>
        <span className="cmd-sep" aria-hidden="true" />
        {/* All three need a semantic view to work against, and the server
            refuses without one. Disabling with the reason attached beats
            opening a panel whose only content is "there is nothing to ask
            about" -- the report is unbound, and the fix is to bind it. */}
        <button
          type="button"
          className="cmd"
          aria-pressed={panel === "ask"}
          disabled={!viewName}
          title={viewName ? "Chat about this data" : UNBOUND_HINT}
          onClick={() => onTogglePanel("ask")}
        >
          <Icon name="chat" />
          Chat
        </button>
        {/* One button, because it is one thing now: the workbook carries the
            numbers AND a connection that refreshes them. "Connect live" was
            a second button for the half this one was missing. The caret
            keeps the fallbacks -- a .odc, the raw SQL -- one click away
            without making them look like a separate feature. */}
        <span className="split-button">
          <button
            type="button"
            className="cmd"
            disabled={exporting || !viewName}
            title={viewName ? "Download the workbook, live-connected" : UNBOUND_HINT}
            onClick={onExportExcel}
          >
            <Icon name="table" />
            {exporting ? "Exporting…" : "Excel"}
          </button>
          <button
            type="button"
            className="cmd split-more"
            aria-label="Other ways to connect from Excel"
            aria-pressed={panel === "connect"}
            disabled={!viewName}
            title={viewName ? "Other ways to connect" : UNBOUND_HINT}
            onClick={() => onTogglePanel("connect")}
          >
            <Icon name="caret" size={13} />
          </button>
        </span>
        <span className="cmd-sep" aria-hidden="true" />
        <button
          type="button"
          className="cmd"
          aria-pressed={panel === "export"}
          onClick={() => onTogglePanel("export")}
        >
          <Icon name="download" />
          Export
        </button>
        {/* Import CREATES a report, so a viewer has nowhere to put one.
            Export stays available to everyone -- reading is what they can
            already do. */}
        {canEdit && (
          <button
            type="button"
            className="cmd"
            aria-pressed={panel === "import"}
            onClick={() => onTogglePanel("import")}
          >
            <Icon name="upload" />
            Import
          </button>
        )}
      </div>
    </header>
  );
}
