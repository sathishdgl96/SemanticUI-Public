import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { columnHandle, type DesignerTableNode } from "./layout";

/**
 * One table of one member view.
 *
 * Every column carries a port on each side, because a conformed dimension
 * is a statement about two COLUMNS — anchoring the edge to the card would
 * say the tables are related, which is a different and weaker claim.
 *
 * A column already in a shared dimension says which one, so the canvas
 * reads without following every line to its other end.
 */
export default function DesignerTable({ data }: NodeProps<DesignerTableNode>) {
  const { alias, table, colour, columns } = data;
  return (
    <div className="designer-table">
      <header className="designer-table-head" style={{ borderTopColor: colour.ink }}>
        <span className="designer-table-name" title={`${alias}.${table}`}>
          {table}
        </span>
        <span className="designer-table-count">{columns.length}</span>
      </header>
      <ul className="designer-columns">
        {columns.length === 0 && (
          <li className="designer-column is-empty">No fields exposed</li>
        )}
        {columns.map((column) => {
          const id = columnHandle(alias.toLowerCase(), table, column.name);
          return (
            <li
              key={column.name}
              className={`designer-column${column.conformed ? " is-conformed" : ""}`}
            >
              <Handle
                type="target"
                position={Position.Left}
                id={`target:${id}`}
                className="designer-port"
              />
              <span className="designer-column-name" title={column.name}>
                {column.name}
              </span>
              {column.conformed && (
                <span className="designer-column-tag" title={`Shared as ${column.conformed}`}>
                  {column.conformed}
                </span>
              )}
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
    </div>
  );
}
