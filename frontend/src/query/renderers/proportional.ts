// Treemap, funnel and gauge: the visual types whose ECharts option is neither
// cartesian (categorical.ts) nor a pie (pie.ts). They share the same "one
// dimension against one measure" well shape, so they also share the row
// extraction below.

import type { QueryResponse, Visual } from "../../api/types";
import { CHART_INK, SERIES_COLORS } from "../palette";
import { hexList } from "./categorical";
import type { LooseRecord, PieOptionLike } from "./categorical";
import { columnIndexOf, fieldName } from "../fieldName";


interface Slice extends LooseRecord {
  name: string;
  value: number;
  itemStyle: LooseRecord;
}

/** The (label, value) pairs a one-by-one visual draws, or null when either
 *  well's field is missing from the result. */
function slices(visual: Visual, result: QueryResponse): Slice[] | null {
  // The author's colours, if any; the shared palette otherwise. See
  // the note on axisChrome.color -- palette.ts is never edited.
  const custom = hexList(visual.options.colors);
  const legendRef = (visual.wells.legend ?? [])[0];
  const valueRef = (visual.wells.values ?? [])[0];
  if (!legendRef || !valueRef) return null;
  const li = columnIndexOf(result.columns, legendRef);
  const vi = columnIndexOf(result.columns, valueRef);
  if (li < 0 || vi < 0) return null;

  return foldByLabel(result.rows, li, vi, custom);
}

/** One entry per distinct label, values summed.
 *
 *  A one-by-one visual can be handed rows at a finer grain than it draws --
 *  a result from before the visual type changed, or a report whose query was
 *  built elsewhere. Taken row by row that renders the same label two or more
 *  times, each holding a fraction of its own total, which is a wrong answer
 *  rather than an untidy one. Colour is assigned after folding so each label
 *  gets exactly one.
 */
export function foldByLabel(
  rows: unknown[][],
  labelIndex: number,
  valueIndex: number,
  custom: string[],
): Slice[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const name = String(row[labelIndex] ?? "");
    const value = Number(row[valueIndex] ?? 0);
    totals.set(name, (totals.get(name) ?? 0) + (Number.isFinite(value) ? value : 0));
  }
  return [...totals].map(([name, value], i) => ({
    name,
    value,
    itemStyle: { color: custom[i] ?? SERIES_COLORS[i % SERIES_COLORS.length] },
  }));
}

export function treemapOption(
  visual: Visual,
  result: QueryResponse,
): PieOptionLike | null {
  const data = slices(visual, result);
  if (!data) return null;
  return {
    backgroundColor: "transparent",
    tooltip: { trigger: "item", confine: true },
    // A treemap labels its own tiles, so a separate legend would repeat every
    // name already drawn on the canvas.
    legend: { show: false },
    series: [
      {
        type: "treemap",
        roam: false,
        // The drill-down breadcrumb ECharts adds by default competes with the
        // report's own drill path in the tile header.
        breadcrumb: { show: false },
        nodeClick: false,
        data,
        label: { color: CHART_INK.surface, fontSize: 12 },
        itemStyle: { borderColor: CHART_INK.surface, borderWidth: 2 },
      },
    ],
  };
}

export function funnelOption(
  visual: Visual,
  result: QueryResponse,
): PieOptionLike | null {
  const data = slices(visual, result);
  if (!data) return null;
  return {
    backgroundColor: "transparent",
    tooltip: { trigger: "item", confine: true },
    legend: { show: true, bottom: 0, textStyle: { color: CHART_INK.secondary } },
    series: [
      {
        type: "funnel",
        // Sorted widest-first: a funnel that does not descend is just a
        // stack of unrelated bars.
        sort: "descending",
        gap: 2,
        // Pixels, and scaled with the tile by responsiveOption: 16 and 40
        // are more than half the height of a short tile before a single
        // stage is drawn.
        top: 16,
        bottom: 40,
        data,
        label: { color: CHART_INK.secondary, position: "inside" },
      },
    ],
  };
}

/** A gauge needs a scale, and the semantic layer gives us no max. The Target
 *  well supplies one when present; otherwise the value itself is the whole
 *  dial, which reads as "100% of itself" -- so the axis is hidden in that
 *  case rather than implying a precision we do not have. */
export function gaugeOption(
  visual: Visual,
  result: QueryResponse,
): PieOptionLike | null {
  const valueRef = (visual.wells.value ?? [])[0];
  if (!valueRef) return null;
  const vi = columnIndexOf(result.columns, valueRef);
  if (vi < 0) return null;
  // The TOTAL, not the first row. A gauge shows one number, so given rows
  // split by a dimension it was showing whichever group happened to sort
  // first -- a number that looks plausible and is simply wrong.
  const sum = (index: number): number =>
    result.rows.reduce((total, row) => {
      const value = Number(row[index] ?? 0);
      return total + (Number.isFinite(value) ? value : 0);
    }, 0);

  const value = sum(vi);
  if (!Number.isFinite(value)) return null;

  const targetRef = (visual.wells.target ?? [])[0];
  const ti = targetRef ? columnIndexOf(result.columns, targetRef) : -1;
  const target = ti >= 0 ? sum(ti) : null;
  const max = target && Number.isFinite(target) && target > 0 ? target : value || 1;

  return {
    backgroundColor: "transparent",
    tooltip: { show: false },
    legend: { show: false },
    series: [
      {
        type: "gauge",
        min: 0,
        max,
        // Percentages, so the dial is a fraction of whatever it is given
        // rather than a fixed size inside it. Centred low because the arc
        // opens downwards and the top half is mostly empty.
        radius: "88%",
        center: ["50%", "58%"],
        progress: { show: true, width: 14 },
        axisLine: { lineStyle: { width: 14, color: [[1, CHART_INK.grid]] } },
        axisLabel: { show: target !== null, color: CHART_INK.muted, distance: 18 },
        axisTick: { show: false },
        splitLine: { show: false },
        pointer: { show: false },
        itemStyle: { color: SERIES_COLORS[0] },
        // ECharts draws `data[].name` as a gauge title, and its default
        // position is a hair below the detail -- so the measure's name and
        // its value were painted across each other. The tile header already
        // says what this is measuring.
        title: { show: false },
        detail: {
          valueAnimation: false,
          color: CHART_INK.secondary,
          fontSize: 22,
          // Dead centre of the dial. It used to sit at 10% below, which
          // put it on the arc itself once the arc shrank.
          offsetCenter: [0, "0%"],
          formatter: (n: number) => new Intl.NumberFormat("en-US").format(n),
        },
        data: [{ value, name: fieldName(valueRef), itemStyle: {} }],
      },
    ],
  };
}
