import type { QueryResponse, Visual } from "../../api/types";
import { CHART_INK } from "../palette";
import { hexList } from "./categorical";
import type { PieOptionLike } from "./categorical";
import { foldByLabel } from "./proportional";
import { columnIndexOf } from "../fieldName";

export function pieOption(visual: Visual, result: QueryResponse): PieOptionLike | null {
  // The author's colours, if any; the shared palette otherwise. See
  // the note on axisChrome.color -- palette.ts is never edited.
  const custom = hexList(visual.options.colors);
  const legendRef = (visual.wells.legend ?? [])[0];
  const valueRef = (visual.wells.values ?? [])[0];
  const idx = (ref: string) => columnIndexOf(result.columns, ref);
  const li = legendRef ? idx(legendRef) : -1;
  const vi = valueRef ? idx(valueRef) : -1;
  if (li < 0 || vi < 0) return null;

  // Folded to one slice per label: rows at a finer grain than the pie draws
  // would otherwise put the same label on the dial two or three times, each
  // holding a fraction of its own total.
  const data = foldByLabel(result.rows, li, vi, custom).map((slice) => ({
    ...slice,
    itemStyle: {
      ...slice.itemStyle,
      borderColor: CHART_INK.surface,
      borderWidth: 2, // the 2px surface gap between adjacent fills
    },
  }));

  // No xAxis/yAxis here — deliberately: a pie chart never renders cartesian
  // axes, and PieOptionLike doesn't claim otherwise (see categorical.ts).
  // This return needs no cast: it's already structurally a PieOptionLike.
  return {
    backgroundColor: "transparent",
    // Confined to the chart's own box: a tile clips its overflow, so a
    // tooltip near an edge would otherwise be drawn half outside and read as
    // truncated data ("ustomer#0001" instead of "Customer#0001").
    tooltip: { trigger: "item", confine: true },
    legend: {
      show: true,
      bottom: 0,
      // One row with arrows, never a wrap: a plain legend of twenty regions
      // stacked into four rows and painted them over the bottom of the dial.
      type: "scroll",
      textStyle: { color: CHART_INK.secondary },
    },
    series: [{
      type: "pie",
      // 55%, not 70%: the labels sit OUTSIDE the slices on leader lines,
      // so the dial has to stop short of the box to leave them somewhere
      // to be. At 70% they ran off the tile and into the legend.
      radius: visual.options.donut ? ["35%", "55%"] : ["0%", "55%"],
      center: ["50%", "45%"],
      data,
      // A sliver under three degrees cannot be pointed at legibly; its
      // label is the one that piles onto its neighbours'.
      minShowLabelAngle: 3,
      label: {
        color: CHART_INK.secondary,
        position: "outside",
        // Anchored to the end of its own leader line rather than to the
        // tile's edge, so a wide tile does not stretch every line to the
        // margins.
        alignTo: "labelLine",
        // Kept inside the box; without it a label near the edge is drawn
        // half outside and the tile clips it.
        bleedMargin: 8,
        // A long name is cut with an ellipsis; the tooltip has the whole of it.
        width: 96,
        overflow: "truncate",
      },
      labelLine: { length: 8, length2: 10 },
      // A label that would land on another is dropped, not drawn over it.
      labelLayout: { hideOverlap: true },
    }],
  };
}
