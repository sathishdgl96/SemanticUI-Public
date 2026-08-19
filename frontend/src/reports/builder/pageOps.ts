/** Pure page transforms. Each returns what should happen, not React calls:
 *  the page applies `definition`, then `focusId`, then `selectId`, or shows
 *  `notice` alone when a limit refused the change. Keeping these as plain
 *  functions makes the limits testable without rendering the builder. */

import type { Page, ReportDefinition, Visual } from "../../api/types";
import { MAX_PAGES, MAX_VISUALS } from "../catalog";

export type PageOpResult = {
  definition?: ReportDefinition;
  focusId?: string;
  selectId?: string;
  notice?: string;
};

const mintPageId = () => `p${crypto.randomUUID().slice(0, 8)}`;
const mintVisualId = () => `v${crypto.randomUUID().slice(0, 8)}`;

const visualTotal = (definition: ReportDefinition) =>
  definition.pages.reduce((sum, p) => sum + p.visuals.length, 0);

export function addPage(definition: ReportDefinition): PageOpResult {
  if (definition.pages.length >= MAX_PAGES) {
    return { notice: `A report can hold at most ${MAX_PAGES} pages.` };
  }
  const used = new Set(definition.pages.map((p) => p.name));
  let n = definition.pages.length + 1;
  while (used.has(`Page ${n}`)) n++;
  const page: Page = {
    id: mintPageId(),
    name: `Page ${n}`,
    visuals: [],
    filters: [],
  };
  return {
    definition: { ...definition, pages: [...definition.pages, page] },
    focusId: page.id,
  };
}

export function addSheet(definition: ReportDefinition): PageOpResult {
  if (definition.pages.length >= MAX_PAGES) {
    return { notice: `A report can hold at most ${MAX_PAGES} pages.` };
  }
  if (visualTotal(definition) + 1 > MAX_VISUALS) {
    return { notice: `A report can hold at most ${MAX_VISUALS} visuals.` };
  }
  const used = new Set(definition.pages.map((p) => p.name));
  let n = 1;
  while (used.has(`Sheet ${n}`)) n++;
  // The sheet's pivot exists from the first moment, so the field list has
  // something to drive -- exactly how Excel inserts an empty PivotTable.
  const pivot: Visual = {
    id: mintVisualId(),
    type: "matrix",
    title: "",
    layout: { x: 0, y: 0, w: 12, h: 24 },
    wells: { rows: [], columns: [], values: [] },
    options: { subtotals: true },
    filters: [],
  };
  const page: Page = {
    id: mintPageId(),
    name: `Sheet ${n}`,
    kind: "sheet",
    visuals: [pivot],
    filters: [],
  };
  return {
    definition: { ...definition, pages: [...definition.pages, page] },
    focusId: page.id,
    selectId: pivot.id,
  };
}

export function renamePage(
  definition: ReportDefinition,
  id: string,
  name: string,
): PageOpResult {
  return {
    definition: {
      ...definition,
      pages: definition.pages.map((p) => (p.id === id ? { ...p, name } : p)),
    },
  };
}

export function duplicatePage(definition: ReportDefinition, id: string): PageOpResult {
  const source = definition.pages.find((p) => p.id === id);
  if (!source) return {};
  if (definition.pages.length >= MAX_PAGES) {
    return { notice: `A report can hold at most ${MAX_PAGES} pages.` };
  }
  if (visualTotal(definition) + source.visuals.length > MAX_VISUALS) {
    return {
      notice: `Duplicating this page would exceed ${MAX_VISUALS} visuals per report.`,
    };
  }
  const used = new Set(definition.pages.map((p) => p.name));
  let name = `Duplicate of ${source.name}`.slice(0, 100);
  for (let n = 2; used.has(name); n++) {
    name = `Duplicate of ${source.name} ${n}`.slice(0, 100);
  }
  const copy: Page = {
    id: mintPageId(),
    name,
    kind: source.kind,
    // Visual ids must be unique across the WHOLE report, so a copy mints
    // fresh ones. Filter ids only have to be unique within their scope.
    visuals: source.visuals.map((v) => ({
      ...structuredClone(v),
      id: mintVisualId(),
    })),
    filters: source.filters.map((f) => ({ ...f })),
  };
  const at = definition.pages.findIndex((p) => p.id === id) + 1;
  const pages = [...definition.pages];
  pages.splice(at, 0, copy);
  return { definition: { ...definition, pages }, focusId: copy.id };
}

export function deletePage(
  definition: ReportDefinition,
  id: string,
  activePageId: string,
): PageOpResult {
  if (definition.pages.length <= 1) return {};
  const remaining = definition.pages.filter((p) => p.id !== id);
  return {
    definition: { ...definition, pages: remaining },
    focusId: activePageId === id ? remaining[0].id : undefined,
  };
}

export function movePage(
  definition: ReportDefinition,
  id: string,
  direction: -1 | 1,
): PageOpResult {
  const from = definition.pages.findIndex((p) => p.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= definition.pages.length) return {};
  const pages = [...definition.pages];
  const [page] = pages.splice(from, 1);
  pages.splice(to, 0, page);
  return { definition: { ...definition, pages } };
}
