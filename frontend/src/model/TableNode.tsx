import { createContext, useContext } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { handleId, type ModelColumn, type TableNode as TableNodeType } from "./graph";
import type { TableState } from "./relatedness";

/** What a card needs from the diagram around it. Passed by context rather
 *  than through `data`, so a callback identity change does not rebuild
 *  every node and re-run the layout. */
export interface NodeContext {
  selectedRef: string | null;
  selectedTable: string | null;
  states: Map<string, TableState> | null;
  onSelectField: (ref: string) => void;
  onSelectTable: (table: string) => void;
  onToggleExpand: (table: string) => void;
}

export const ModelNodeContext = createContext<NodeContext>({
  selectedRef: null,
  selectedTable: null,
  states: null,
  onSelectField: () => {},
  onSelectTable: () => {},
  onToggleExpand: () => {},
});

/** `VARCHAR(16777216)` is noise in a card this size; the type family is
 *  the part that says what a column is. */
function shortType(dataType: string | null): string {
  if (!dataType) return "";
  return dataType.split("(")[0].toUpperCase().slice(0, 8);
}

/** The four handles a join key row offers.
 *
 *  Both sides and both roles, because which one an edge uses is decided
 *  after layout from the relative position of the two cards -- a line
 *  arriving at the side it should have left from loops back over its own
 *  card. React Flow resolves a source handle only among source handles,
 *  so both roles have to exist at both sides. */
function KeyHandles({ column }: { column: string }) {
  return (
    <>
      <Handle
        type="source"
        position={Position.Left}
        id={handleId("source", "left", column)}
        isConnectable={false}
      />
      <Handle
        type="target"
        position={Position.Left}
        id={handleId("target", "left", column)}
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Right}
        id={handleId("source", "right", column)}
        isConnectable={false}
      />
      <Handle
        type="target"
        position={Position.Right}
        id={handleId("target", "right", column)}
        isConnectable={false}
      />
    </>
  );
}

function ColumnRow({
  column,
  table,
  selected,
  onSelect,
}: {
  column: ModelColumn;
  table: string;
  selected: boolean;
  onSelect: (ref: string) => void;
}) {
  const classes = [
    "model-column",
    `kind-${column.kind}`,
    selected ? "selected" : "",
  ]
    .join(" ")
    .trim();

  const body = (
    <>
      <span className="model-column-name">
        {column.kind === "key" && (
          <span className="model-key" aria-hidden="true">
            ⚿
          </span>
        )}
        {column.name}
      </span>
      <span className="model-column-type">{shortType(column.dataType)}</span>
    </>
  );

  return (
    <li className="model-column-row">
      {column.kind === "key" && <KeyHandles column={column.name} />}
      {column.ref ? (
        // `nodrag` or pressing a column would drag the card instead.
        <button
          type="button"
          className={`${classes} nodrag`}
          aria-pressed={selected}
          onClick={() => onSelect(column.ref as string)}
          title={`${table}.${column.name} — show what this relates to`}
        >
          {body}
        </button>
      ) : (
        // A join key names a physical column, not a field of the semantic
        // view, so there is nothing to select and nothing to query.
        <span className={classes} title="Join key — not a queryable field">
          {body}
        </span>
      )}
    </li>
  );
}

/**
 * One table, drawn as an ER card.
 *
 * Plain HTML rather than SVG shapes: the text is real text at a real font
 * size, the rows are real buttons, and a join edge can anchor to the key
 * row it is actually declared on instead of to the middle of a box.
 */
export default function TableNode({ data }: NodeProps<TableNodeType>) {
  const {
    selectedRef,
    selectedTable,
    states,
    onSelectField,
    onSelectTable,
    onToggleExpand,
  } = useContext(ModelNodeContext);

  const state = states?.get(data.table.toUpperCase()) ?? null;
  const classes = [
    "model-node",
    `kind-${data.kind}`,
    selectedTable === data.table ? "selected" : "",
    state ? `state-${state}` : "",
  ]
    .join(" ")
    .trim();

  return (
    <div className={classes} data-table={data.table}>
      {/* The card's own anchors, for a relationship whose describe
          carried no key columns to attach to. */}
      <KeyHandles column="" />

      <button
        type="button"
        className="model-node-head nodrag"
        onClick={() => onSelectTable(data.table)}
        aria-pressed={selectedTable === data.table}
      >
        <span className="model-node-name">{data.table}</span>
        <span className="model-node-kind">{data.kind}</span>
        <span className="model-node-count">{data.fieldCount}</span>
      </button>

      {data.columns.length > 0 && (
        <ul className="model-node-columns">
          {data.columns.map((column) => (
            <ColumnRow
              key={`${column.kind}:${column.name}`}
              column={column}
              table={data.table}
              selected={selectedRef !== null && selectedRef === column.ref}
              onSelect={onSelectField}
            />
          ))}
        </ul>
      )}

      {(data.hidden > 0 || data.expanded) && (
        <button
          type="button"
          className="model-node-more nodrag"
          onClick={() => onToggleExpand(data.table)}
        >
          {data.hidden > 0 ? `+${data.hidden} more` : "Show fewer"}
        </button>
      )}
    </div>
  );
}
