import type { QueryResponse } from "../api/types";

export default function ResultsTable({ result }: { result: QueryResponse }) {
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
