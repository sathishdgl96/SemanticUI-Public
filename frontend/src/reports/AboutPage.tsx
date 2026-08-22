import type { ReactNode } from "react";
import type { Freshness, FreshnessRow, Provenance } from "../api/provenance";
import { ageSince, dayStamp } from "../ui/age";
import { relativeTime } from "../ui/relativeTime";

/** What one source row honestly says when it has no date. The distinction
 *  the whole freshness derivation exists for lives here: a definition change
 *  is never worded as a data update. */
function undated(row: FreshnessRow): string {
  switch (row.state) {
    case "definition-only":
      return "No data change recorded";
    case "not-visible":
      return "Not visible to your role";
    case "query-backed":
      return "Defined by a query";
    default:
      return "No source recorded";
  }
}

/** Stalest first: the table is ordered by the question it answers, so the
 *  row dragging this report down is the first one read. Sources with no date
 *  are not stale, they are unknown, so they sort after rather than above. */
function byStaleness(rows: FreshnessRow[]): FreshnessRow[] {
  return [...rows].sort((a, b) => {
    const left = a.state === "updated" && a.at ? Date.parse(a.at) : Infinity;
    const right = b.state === "updated" && b.at ? Date.parse(b.at) : Infinity;
    if (left !== right) return left - right;
    return a.name.localeCompare(b.name);
  });
}

/** The `database.schema` every source shares, or null when they differ.
 *
 *  Seven rows of `SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.` spend the width of the
 *  column on the one part identical in all of them. Said once above the
 *  table, each row keeps only the part that varies. If a model ever spans
 *  databases the prefix stops being common and the full name comes back. */
function commonPrefix(rows: FreshnessRow[]): string | null {
  const sources = rows.map((r) => r.source).filter((s): s is string => !!s);
  if (sources.length < 2) return null;
  const prefixes = new Set(
    sources.map((s) => s.split(".").slice(0, -1).join(".")),
  );
  return prefixes.size === 1 ? [...prefixes][0] : null;
}

function sourceLabel(row: FreshnessRow, prefix: string | null): string {
  if (!row.source) return "—";
  return prefix ? row.source.slice(prefix.length + 1) : row.source;
}

function FreshnessBlock({ freshness }: { freshness: Freshness }) {
  if (!freshness.available) {
    return (
      <p className="about-unavailable">
        Source freshness unavailable — the query could not be run.
        {freshness.reason ? (
          <>
            {" "}
            <span className="about-reason">{freshness.reason}</span>
          </>
        ) : null}
      </p>
    );
  }

  const rows = byStaleness(freshness.tables);
  const dated = rows.filter((row) => row.state === "updated" && row.at);
  const prefix = commonPrefix(rows);
  const newest = dated.length ? dated[dated.length - 1].at : null;

  return (
    <>
      <p className="about-headline" data-testid="freshness-headline">
        {freshness.oldest ? (
          <>
            Oldest source <strong>{dayStamp(freshness.oldest)}</strong>
            {newest && newest !== freshness.oldest ? (
              <> · newest {dayStamp(newest)}</>
            ) : null}
          </>
        ) : (
          "No source has a recorded data change"
        )}
      </p>
      {!freshness.complete ? (
        <p className="about-partial">
          Covers the {dated.length} of {rows.length} sources with a recorded
          change.
        </p>
      ) : null}
      {prefix ? <p className="about-prefix">All from {prefix}</p> : null}

      <div className="about-table-wrap">
        <table className="about-table about-freshness">
          <thead>
            <tr>
              <th scope="col">Table</th>
              <th scope="col">Source</th>
              <th scope="col">Data as of</th>
              <th scope="col" className="about-num">
                Age
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const known = row.state === "updated" && row.at;
              return (
                <tr key={row.name}>
                  <th scope="row">
                    {row.name}
                    {row.isDynamic ? (
                      <span className="about-tag">dynamic</span>
                    ) : null}
                  </th>
                  <td className="about-source">{sourceLabel(row, prefix)}</td>
                  {known ? (
                    <>
                      <td>
                        <time dateTime={row.at ?? undefined}>
                          {dayStamp(row.at)}
                        </time>
                      </td>
                      <td className="about-num">{ageSince(row.at)}</td>
                    </>
                  ) : (
                    <td className="about-undated" colSpan={2}>
                      {undated(row)}
                      {row.state === "definition-only" && row.at
                        ? ` — definition changed ${dayStamp(row.at)}`
                        : null}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="about-caveat">
        Read from Snowflake's table metadata. Background maintenance moves the
        same timestamp a load does, so this can read slightly fresher than the
        last load.
      </p>
    </>
  );
}

/**
 * What this report is built on, and how current it is.
 *
 * Appended to every report in view mode. The four blocks are assembled
 * server-side and fail independently on purpose: a model can be certified
 * while its freshness is unreadable -- a stopped warehouse is the ordinary
 * case -- and this page has to render either way.
 */
export default function AboutPage({
  data,
  certify,
}: {
  data: Provenance;
  /** The certification control, when the page has a live view to offer one
   *  for. A slot rather than a query, so this component stays presentational
   *  and every state below can be tested without a server. */
  certify?: ReactNode;
}) {
  const { model, freshness, lineage, openIssues } = data;

  return (
    <section className="about-page">
      <section className="about-block">
        <h3>Model</h3>
        <p className="about-model-name">
          <span className="about-model-scope">
            {model.database}.{model.schema}.
          </span>
          <strong>{model.name}</strong>
        </p>

        <p className="about-status">
          <span
            className={model.certified ? "about-badge" : "about-badge is-none"}
          >
            {model.certified ? "Certified" : "Not certified"}
          </span>
          <span className="about-status-owner">
            {model.owner.name ? (
              <>
                {model.owner.name}
                {model.owner.contact ? (
                  <span className="about-contact"> · {model.owner.contact}</span>
                ) : null}
              </>
            ) : (
              "No owner named"
            )}
          </span>
        </p>

        <p className="about-status-detail">
          {model.certified && model.certifiedBy ? (
            <>
              Vouched for under the Snowflake role{" "}
              <code>{model.certifiedBy.role}</code>,{" "}
              {relativeTime(model.certifiedBy.at)}.
            </>
          ) : (
            "Nobody holding the owning Snowflake role has vouched for this model."
          )}
          {!model.owner.name
            ? " There is nobody listed to ask when the numbers look wrong."
            : null}
        </p>

        {model.note ? <p className="about-note">{model.note}</p> : null}
        {certify}
      </section>

      <section className="about-block">
        <h3>Source freshness</h3>
        <FreshnessBlock freshness={freshness} />
      </section>

      <section className="about-block about-block--pending">
        <h3>Lineage</h3>
        <p className="about-placeholder">{lineage.placeholder}</p>
      </section>

      <section className="about-block about-block--pending">
        <h3>Open issues</h3>
        {/* No table furniture for rows that do not exist: a header row above
            one spanning cell implies a grid somebody could fill. */}
        <p className="about-placeholder">{openIssues.placeholder}</p>
      </section>
    </section>
  );
}
