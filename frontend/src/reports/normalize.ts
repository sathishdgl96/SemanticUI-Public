import type { Page, ReportDefinition, Visual } from "../api/types";

/** The shape an older build stored: visuals at the top level, no pages. */
interface LegacyDefinition {
  visuals?: Visual[];
  pages?: Page[];
}

/** Bring a definition up to the current shape.
 *
 *  The backend migrates on both the read and write paths, so in normal
 *  operation this is a no-op. It exists because "the server always sends the
 *  current shape" is an assumption the UI should not stake a blank screen on:
 *  a server mid-deploy, a response cached by the browser from before an
 *  upgrade, or a hand-written definition pasted into the import box all
 *  produce a document with `visuals` and no `pages`. Reading `.pages.find`
 *  on one of those threw, and React unmounted the whole builder -- the user
 *  saw an empty page with no way to tell what went wrong.
 *
 *  Mirrors `_v2_to_v3` in backend/app/reports/migrate.py: the old top-level
 *  filters were the page scope, so they travel onto the migrated page. */
export function normalizeDefinition(raw: ReportDefinition): ReportDefinition {
  const legacy = raw as ReportDefinition & LegacyDefinition;
  if (Array.isArray(legacy.pages) && legacy.pages.length > 0) {
    // Already current, but a page missing its own collections would fail the
    // same way one level down.
    return {
      ...raw,
      pages: legacy.pages.map((page) => ({
        ...page,
        visuals: page.visuals ?? [],
        filters: page.filters ?? [],
      })),
      filters: raw.filters ?? [],
      hierarchies: raw.hierarchies ?? [],
    };
  }

  const { visuals, ...rest } = legacy;
  return {
    ...(rest as ReportDefinition),
    schemaVersion: 3,
    pages: [
      {
        id: "p1",
        name: "Page 1",
        visuals: visuals ?? [],
        filters: raw.filters ?? [],
      },
    ],
    filters: [],
    hierarchies: raw.hierarchies ?? [],
  };
}
