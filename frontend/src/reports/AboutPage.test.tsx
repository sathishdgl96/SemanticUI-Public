import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Freshness, FreshnessRow, Provenance } from "../api/provenance";
import AboutPage from "./AboutPage";

const FRESH: Freshness = {
  tables: [
    {
      name: "ORDERS", source: "SALES.PUBLIC.ORDERS_RAW", state: "updated",
      at: "2026-08-22T06:15:00Z", isDynamic: false, rowCount: 42,
    },
  ],
  oldest: "2026-08-22T06:15:00Z",
  complete: true,
  available: true,
  reason: null,
};

function provenance(over: Partial<Provenance> = {}): Provenance {
  return {
    model: {
      database: "SALES", schema: "PUBLIC", name: "REVENUE",
      certified: false, owner: { name: null, contact: null },
      certifiedBy: null, note: null,
    },
    freshness: FRESH,
    lineage: { available: false, placeholder: "Lineage is not wired up yet." },
    openIssues: {
      available: false, columns: ["Issue", "Where", "Detail"], issues: [],
      placeholder: "Checks are not wired up yet.",
    },
    ...over,
  };
}

describe("AboutPage", () => {
  it("says plainly when nobody has certified the model", () => {
    render(<AboutPage data={provenance()} />);

    expect(screen.getByText(/not certified/i)).toBeInTheDocument();
  });

  it("names the Snowflake role that vouched for a certified model", () => {
    // The role, not the person: authority is what the record is for.
    render(
      <AboutPage
        data={provenance({
          model: {
            ...provenance().model, certified: true,
            certifiedBy: { role: "DATA_ENG", at: "2026-08-20T09:00:00Z" },
            owner: { name: "Revenue team", contact: "rev@example.com" },
          },
        })}
      />,
    );

    expect(screen.getByText(/DATA_ENG/)).toBeInTheDocument();
    expect(screen.getByText(/Revenue team/)).toBeInTheDocument();
  });

  it("leads with the stalest source rather than the most recent", () => {
    render(<AboutPage data={provenance()} />);

    // A report is only as current as its oldest input.
    expect(screen.getByTestId("freshness-headline")).toBeInTheDocument();
  });

  it("never calls a definition change a data update", () => {
    // The whole reason LAST_ALTERED is compared against LAST_DDL.
    render(
      <AboutPage
        data={provenance({
          freshness: {
            ...FRESH,
            tables: [{
              ...FRESH.tables[0], state: "definition-only",
              at: "2026-08-13T00:00:00Z",
            }],
            oldest: null, complete: false,
          },
        })}
      />,
    );

    // Says what did not happen, and dates only what did.
    expect(screen.getByText(/no data change recorded/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Updated/)).not.toBeInTheDocument();
  });

  it("says a table is invisible to the reader's role rather than blaming the data", () => {
    render(
      <AboutPage
        data={provenance({
          freshness: {
            ...FRESH,
            tables: [{ ...FRESH.tables[0], state: "not-visible", at: null }],
            oldest: null, complete: false,
          },
        })}
      />,
    );

    expect(screen.getByText(/not visible to your role/i)).toBeInTheDocument();
  });

  it("says why freshness could not be read, not merely that it could not", () => {
    // "The query could not be run" with nothing after it is a dead end for
    // whoever has to fix it. The first real failure here was a placeholder
    // style Snowflake rejected, and the page said nothing about it.
    render(
      <AboutPage
        data={provenance({
          freshness: {
            tables: [], oldest: null, complete: false, available: false,
            reason: "SQL compilation error: no active warehouse",
          },
        })}
      />,
    );

    expect(screen.getByText(/no active warehouse/i)).toBeInTheDocument();
  });

  it("keeps the model block when freshness could not be read at all", () => {
    render(
      <AboutPage
        data={provenance({
          freshness: {
            tables: [], oldest: null, complete: false, available: false,
            reason: null,
          },
        })}
      />,
    );

    expect(screen.getByText(/freshness unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/REVENUE/)).toBeInTheDocument();
  });

  it("shows lineage and open issues as declared placeholders, not as silence", () => {
    // A block that rendered nothing would be indistinguishable from a model
    // with no lineage and no problems, which is the wrong claim.
    render(<AboutPage data={provenance()} />);

    expect(screen.getByText(/lineage is not wired up yet/i)).toBeInTheDocument();
    expect(screen.getByText(/checks are not wired up yet/i)).toBeInTheDocument();
  });
});

describe("the freshness table is ordered and trimmed for comparison", () => {
  const source = (name: string, table: string, at: string): FreshnessRow => ({
    name,
    source: `SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.${table}`,
    state: "updated",
    at,
    isDynamic: false,
    rowCount: 1,
  });

  const SPREAD: Freshness = {
    tables: [
      source("ORDERS", "ORDERS", "2026-08-20T00:00:00Z"),
      source("PART", "PART", "2024-12-14T00:00:00Z"),
      source("NATION", "NATION", "2025-07-09T00:00:00Z"),
    ],
    oldest: "2024-12-14T00:00:00Z",
    complete: true,
    available: true,
    reason: null,
  };

  function rowOrder(): string[] {
    return screen
      .getAllByRole("rowheader")
      .map((cell) => cell.textContent ?? "");
  }

  it("puts the stalest source first, because that is the one dragging the report", () => {
    render(<AboutPage data={provenance({ freshness: SPREAD })} />);

    expect(rowOrder()).toEqual(["PART", "NATION", "ORDERS"]);
  });

  it("states the spread rather than letting the oldest stand for everything", () => {
    // "Sources last updated Dec 14, 2024" read as a verdict on the whole
    // model while one of its tables had updated two days earlier.
    render(<AboutPage data={provenance({ freshness: SPREAD })} />);

    const headline = screen.getByTestId("freshness-headline");
    expect(headline).toHaveTextContent(/oldest source/i);
    expect(headline).toHaveTextContent(/newest/i);
  });

  it("says the shared database and schema once instead of on every row", () => {
    render(<AboutPage data={provenance({ freshness: SPREAD })} />);

    expect(
      screen.getByText(/All from SNOWFLAKE_SAMPLE_DATA\.TPCH_SF1/),
    ).toBeInTheDocument();
    // The row keeps only the part that varies.
    expect(screen.getByText("ORDERS", { selector: "td" })).toBeInTheDocument();
  });

  it("keeps the full name when sources do not share a schema", () => {
    const mixed: Freshness = {
      ...SPREAD,
      tables: [
        source("ORDERS", "ORDERS", "2026-08-20T00:00:00Z"),
        { ...source("EXTRA", "EXTRA", "2026-08-19T00:00:00Z"), source: "OTHER_DB.SALES.EXTRA" },
      ],
    };
    render(<AboutPage data={provenance({ freshness: mixed })} />);

    expect(screen.queryByText(/^All from/)).not.toBeInTheDocument();
    expect(screen.getByText("OTHER_DB.SALES.EXTRA")).toBeInTheDocument();
  });

  it("carries a machine-readable date beside the one a person reads", () => {
    render(<AboutPage data={provenance({ freshness: SPREAD })} />);

    const stamps = screen.getAllByText(/2024|2025|2026/, { selector: "time" });
    expect(stamps[0]).toHaveAttribute("dateTime", "2024-12-14T00:00:00Z");
  });
});
