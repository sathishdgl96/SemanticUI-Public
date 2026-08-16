// Treemap, funnel and gauge: the visual types whose ECharts option is neither
// cartesian (categorical.ts) nor a pie (pie.ts). They share the same "one
// dimension against one measure" well shape, so they also share the row
// extraction below.

import type { QueryResponse, Visual } from "../../api/types";
import { CHART_INK, SERIES_COLORS } from "../palette";
import type { LooseRecord, PieOptionLike } from "./categorical";

function fieldName(ref: string): string {
  return ref.split(".", 2)[1] ?? ref;
}

function columnIndex(result: QueryResponse, name: string): number {
  return result.columns.findIndex((c) => c.name.toUpperCase() === name.toUpperCase());
}

interface Slice extends LooseRecord {
  name: string;
  value: number;
  itemStyle: LooseRecord;
}

/** The (label, value) pairs a one-by-one visual draws, or null when either
 *  well's field is missing from the result. */
function slices(visual: Visual, result: QueryResponse): Slice[] | null {
  const legendRef = (visual.wells.legend ?? [])[0];
  const valueRef = (visual.wells.values ?? [])[0];
  if (!legendRef || !valueRef) return null;
  const li = columnIndex(result, fieldName(legendRef));
  const vi = columnIndex(result, fieldName(valueRef));
  if (li < 0 || vi < 0) return null;

  return result.rows.map((row, i) => ({
    name: String(row[li] ?? ""),
    value: Number(row[vi] ?? 0),
    itemStyle: { color: SERIES_COLORS[i % SERIES_COLORS.length] },
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
    tooltip: { trigger: "item" },
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
    tooltip: { trigger: "item" },
    legend: { show: true, bottom: 0, textStyle: { color: CHART_INK.secondary } },
    series: [
      {
        type: "funnel",
        // Sorted widest-first: a funnel that does not descend is just a
        // stack of unrelated bars.
        sort: "descending",
        gap: 2,
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
  const vi = columnIndex(result, fieldName(valueRef));
  if (vi < 0) return null;
  const value = Number(result.rows[0]?.[vi] ?? 0);
  if (!Number.isFinite(value)) return null;

  const targetRef = (visual.wells.target ?? [])[0];
  const ti = targetRef ? columnIndex(result, fieldName(targetRef)) : -1;
  const target = ti >= 0 ? Number(result.rows[0]?.[ti] ?? 0) : null;
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
        progress: { show: true, width: 14 },
        axisLine: { lineStyle: { width: 14, color: [[1, CHART_INK.grid]] } },
        axisLabel: { show: target !== null, color: CHART_INK.muted, distance: 18 },
        axisTick: { show: false },
        splitLine: { show: false },
        pointer: { show: false },
        itemStyle: { color: SERIES_COLORS[0] },
        detail: {
          valueAnimation: false,
          color: CHART_INK.secondary,
          fontSize: 22,
          offsetCenter: [0, "10%"],
          formatter: (n: number) => new Intl.NumberFormat("en-US").format(n),
        },
        data: [{ value, name: fieldName(valueRef), itemStyle: {} }],
      },
    ],
  };
}
