import type { ColumnInfo } from "../api/types";

/** Only what this component reads. Narrower than QueryResponse on purpose:
 *  an Ask answer has no sfqid, and demanding one would force callers to
 *  invent a field rather than express what they actually have. */
export interface TabularResult {
  columns: ColumnInfo[];
  rows: unknown[][];
  truncated: boolean;
}

export default function ResultsTable({ result }: { result: TabularResult }) {
  return (
    <div className="results">
      {result.truncated && (
        <p className="banner">Results truncated to {result.rows.length} rows.</p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {result.columns.map((col) => (
                <th key={col.name} scope="col">
                  {col.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i}>
                {row.map((value, j) => (
                  <td key={j}>{value === null ? "" : String(value)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
