import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { columnHandle, type BackdropNode } from "./layout";

/**
 * One member view: a coloured area its tables live in.
 *
 * Collapsed it is not empty — it lists the columns this view contributes
 * to a conformed dimension, each with the handles an edge anchors to. A
 * backdrop that showed only a name would leave every edge pointing at a
 * box, which says two views are related but not on what.
 */
export default function Backdrop({ data }: NodeProps<BackdropNode>) {
  const { alias, view, colour, expanded, tableCount, summary, readable, problem } =
    data;
  return (
    <div
      className={`designer-backdrop${expanded ? " is-open" : ""}`}
      style={{
        // Inline because the colour is per view and assigned at layout
        // time; a class per palette entry would be eight dead rules.
        background: colour.wash,
        borderColor: colour.ink,
      }}
    >
      {/* `nodrag`, or React Flow claims the pointer for a node drag and
          the click never lands -- which is exactly how this shipped once
          with a toggle that did nothing. The whole header is the target:
          a 12px chevron is a poor thing to ask somebody to hit on a
          canvas they are also panning. */}
      <button
        type="button"
        className="designer-backdrop-head designer-toggle nodrag"
        style={{ color: colour.ink }}
        data-alias={alias}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${alias}`}
      >
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <span className="designer-backdrop-name">{alias}</span>
        <span className="designer-backdrop-count">
          {readable
            ? tableCount === 1
              ? "1 table"
              : `${tableCount} tables`
            : "cannot be read"}
        </span>
      </button>
      {/* Its own control rather than part of the header button: removing
          a view and expanding one are different enough that sharing a
          target would be a trap. `nodrag` for the same reason the header
          needs it. */}
      <button
        type="button"
        className="designer-remove nodrag"
        data-alias={alias}
        aria-label={`Remove ${alias} from this model`}
        title={`Remove ${alias}`}
      >
        ×
      </button>
      <p className="designer-backdrop-view" title={view}>
        {view}
      </p>

      {!readable && (
        <p className="designer-unreadable" role="note">
          {problem
            ? `This view could not be described: ${problem}`
            : "This view returned no fields."}
        </p>
      )}

      {!expanded && readable && (
        <ul className="designer-summary">
          {summary.length === 0 && (
            <li className="designer-summary-empty">Nothing shared yet</li>
          )}
          {summary.map((row) => {
            const id = columnHandle(alias.toLowerCase(), row.table, row.column);
            return (
              <li key={id} className="designer-summary-row">
                <Handle
                  type="target"
                  position={Position.Left}
                  id={`target:${id}`}
                  className="designer-port"
                />
                <span className="designer-summary-dim">{row.dimension}</span>
                <span className="designer-summary-col" title={`${row.table}.${row.column}`}>
                  {row.table}.{row.column}
                </span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={`source:${id}`}
                  className="designer-port"
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
