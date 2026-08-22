import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Freshness, Provenance } from "../api/provenance";
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

    expect(screen.getByText(/no update recorded/i)).toBeInTheDocument();
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
