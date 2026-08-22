import type { FreshnessRow, Provenance } from "../api/provenance";
import { relativeTime } from "../ui/relativeTime";

function when(at: string | null): string {
  if (!at) return "unknown";
  return relativeTime(at);
}

/** What one source row honestly says. The distinction the whole freshness
 *  derivation exists for is here: a definition change is never worded as a
 *  data update. */
function freshnessCell(row: FreshnessRow): string {
  switch (row.state) {
    case "updated":
      return `Updated ${when(row.at)}`;
    case "definition-only":
      return `No update recorded since the definition changed ${when(row.at)}`;
    case "not-visible":
      return "Not visible to your role";
    case "query-backed":
      return "Derived from a query — no single source table";
    default:
      return "No source table recorded in the model";
  }
}

/**
 * What this report is built on, and how current it is.
 *
 * Appended to every report in view mode. The four blocks are assembled
 * server-side and fail independently on purpose: a model can be certified
 * while its freshness is unreadable -- a stopped warehouse is the ordinary
 * case -- and this page has to render either way.
 */
export default function AboutPage({ data }: { data: Provenance }) {
  const { model, freshness, lineage, openIssues } = data;

  return (
    <section className="about-page">
      <section className="about-block">
        <h3>Model</h3>
        <p className="about-model-name">
          {model.database}.{model.schema}.<strong>{model.name}</strong>
        </p>
        {model.certified ? (
          <p className="about-certified">
            <span className="about-badge">Certified</span>
            {model.certifiedBy ? (
              <>
                {" "}
                under the Snowflake role <code>{model.certifiedBy.role}</code>,{" "}
                {when(model.certifiedBy.at)}
              </>
            ) : null}
          </p>
        ) : (
          <p className="about-uncertified">
            Not certified. Nobody holding the role that owns this model has
            vouched for it.
          </p>
        )}
        <p className="about-owner">
          {model.owner.name ? (
            <>
              Owner: <strong>{model.owner.name}</strong>
              {model.owner.contact ? ` · ${model.owner.contact}` : null}
            </>
          ) : (
            "No owner named — there is nobody listed to ask when the numbers look wrong."
          )}
        </p>
        {model.note ? <p className="about-note">{model.note}</p> : null}
      </section>

      <section className="about-block">
        <h3>Source freshness</h3>
        {!freshness.available ? (
          <p className="about-unavailable">
            Source freshness unavailable — the query could not be run.
          </p>
        ) : (
          <>
            <p className="about-headline" data-testid="freshness-headline">
              {freshness.oldest
                ? `Sources last updated ${when(freshness.oldest)}`
                : "No source update recorded"}
              {!freshness.complete ? (
                <span className="about-partial">
                  {" "}
                  — covers only the sources listed as updated below.
                </span>
              ) : null}
            </p>
            <div className="about-table-wrap">
              <table className="about-table">
                <thead>
                  <tr>
                    <th scope="col">Table</th>
                    <th scope="col">Source</th>
                    <th scope="col">Data</th>
                  </tr>
                </thead>
                <tbody>
                  {freshness.tables.map((row) => (
                    <tr key={row.name}>
                      <th scope="row">
                        {row.name}
                        {row.isDynamic ? (
                          <span className="about-tag">dynamic</span>
                        ) : null}
                      </th>
                      <td>{row.source ?? "—"}</td>
                      <td>{freshnessCell(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Said here rather than only in the design doc: background
                maintenance moves the same timestamp a load does, and a page
                about trust should not quietly round that off. */}
            <p className="about-caveat">
              Read from Snowflake's own table metadata. Background maintenance
              can move this timestamp too, so it may read slightly fresher than
              the last load.
            </p>
          </>
        )}
      </section>

      <section className="about-block">
        <h3>Lineage</h3>
        <p className="about-placeholder">{lineage.placeholder}</p>
      </section>

      <section className="about-block">
        <h3>Open issues</h3>
        <div className="about-table-wrap">
          <table className="about-table">
            <thead>
              <tr>
                {openIssues.columns.map((column) => (
                  <th scope="col" key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={openIssues.columns.length}>
                  <span className="about-placeholder">
                    {openIssues.placeholder}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
