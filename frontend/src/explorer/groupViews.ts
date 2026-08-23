import type { SemanticViewSummary } from "../api/types";

export function groupViews(
  views: SemanticViewSummary[],
): Record<string, Record<string, SemanticViewSummary[]>> {
  const grouped: Record<string, Record<string, SemanticViewSummary[]>> = {};
  for (const view of views) {
    grouped[view.database] ??= {};
    grouped[view.database][view.schema] ??= [];
    grouped[view.database][view.schema].push(view);
  }
  return grouped;
}
