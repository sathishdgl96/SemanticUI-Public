import { describe, expect, it } from "vitest";
import type { QueryResponse, Visual } from "../../api/types";
import { SERIES_COLORS } from "../palette";
import type { CategoricalOptionLike, PieOptionLike, ScatterOptionLike } from "./categorical";
import { buildVisualOption, visualTitle } from "./index";

const categorical: QueryResponse = {
  columns: [
    { name: "REGION", type: "TEXT" },
    { name: "REVENUE", type: "FIXED" },
  ],
  rows: [["EAST", 10], ["WEST", 20]],
  truncated: false,
  sfqid: null,
  sql: "",
};

function visual(over: Partial<Visual>): Visual {
  return {
    id: "v1",
    type: "bar",
    title: "",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells: { axis: ["C.REGION"], legend: [], values: ["A.REVENUE"] },
    options: {},
    filters: [],
    ...over,
  };
}

describe("buildVisualOption", () => {
  it("builds a bar with the stable first series colour", () => {
    // buildVisualOption's return type is the union of what each visual
    // family actually produces (see categorical.ts) — narrowed here to the
    // member this bar visual is known to return, the same way a caller
    // would narrow on visual.type before touching bar-specific fields.
    const option = buildVisualOption(visual({}), categorical)! as CategoricalOptionLike;
    expect(option.series[0].type).toBe("bar");
    expect(option.series[0].itemStyle.color).toBe(SERIES_COLORS[0]);
    expect(option.series[0].itemStyle.borderRadius).toEqual([4, 4, 0, 0]);
  });

  it("stacks bars only when the option says so", () => {
    const bar = buildVisualOption(visual({}), categorical)! as CategoricalOptionLike;
    expect(bar.series[0].stack).toBeUndefined();
    const stacked = buildVisualOption(
      visual({ options: { stacked: true } }),
      categorical,
    )! as CategoricalOptionLike;
    expect(stacked.series[0].stack).toBe("total");
  });

  it("builds a line at 2px and an area with a fill", () => {
    const line = buildVisualOption(visual({ type: "line" }), categorical)! as CategoricalOptionLike;
    expect(line.series[0].type).toBe("line");
    expect(line.series[0].lineStyle.width).toBe(2);
    expect(line.series[0].areaStyle).toBeUndefined();
    const area = buildVisualOption(visual({ type: "area" }), categorical)! as CategoricalOptionLike;
    expect(area.series[0].areaStyle).toBeDefined();
  });

  it("builds a pie whose slices carry the palette in order", () => {
    const option = buildVisualOption(
      visual({ type: "pie", wells: { legend: ["C.REGION"], values: ["A.REVENUE"] } }),
      categorical,
    )! as PieOptionLike;
    expect(option.series[0].type).toBe("pie");
    expect(option.series[0].data.map((d) => d.name)).toEqual(["EAST", "WEST"]);
    expect(option.series[0].data[1].itemStyle.color).toBe(SERIES_COLORS[1]);
    expect(option.series[0].radius).toEqual(["0%", "70%"]);
  });

  it("makes a donut when asked", () => {
    const option = buildVisualOption(
      visual({
        type: "pie",
        wells: { legend: ["C.REGION"], values: ["A.REVENUE"] },
        options: { donut: true },
      }),
      categorical,
    )! as PieOptionLike;
    expect(option.series[0].radius).toEqual(["45%", "70%"]);
  });

  it("builds a scatter with both metrics on value axes", () => {
    const scatterResult: QueryResponse = {
      columns: [
        { name: "REVENUE", type: "FIXED" },
        { name: "QUANTITY", type: "FIXED" },
      ],
      rows: [[10, 1], [20, 2]],
      truncated: false, sfqid: null, sql: "",
    };
    const option = buildVisualOption(
      visual({ type: "scatter", wells: { x: ["A.REVENUE"], y: ["A.QUANTITY"], detail: [] } }),
      scatterResult,
    )! as ScatterOptionLike;
    expect(option.series[0].type).toBe("scatter");
    expect(option.xAxis.type).toBe("value");
    expect(option.yAxis.type).toBe("value");
    expect(option.series[0].data).toEqual([[10, 1], [20, 2]]);
    expect(option.series[0].symbolSize).toBeGreaterThanOrEqual(8);
  });

  it("thins category labels by default, as the chart library does", () => {
    const option = buildVisualOption(visual({}), categorical)! as CategoricalOptionLike;
    expect(option.xAxis.axisLabel).not.toHaveProperty("interval");
    expect(option.xAxis.axisLabel).not.toHaveProperty("rotate");
  });

  it("shows every category label, slanted, when asked to", () => {
    // ECharts drops any label that would touch its neighbour, so a bar
    // chart with twenty categories named six of them. Slanting the text is
    // what makes room for all of it.
    const plain = buildVisualOption(visual({}), categorical)! as CategoricalOptionLike;
    const all = buildVisualOption(
      visual({ options: { categoryLabels: "all" } }),
      categorical,
    )! as CategoricalOptionLike;
    const label = all.xAxis.axisLabel as Record<string, unknown>;
    expect(label.interval).toBe(0);
    expect(label.rotate).toBe(45);
    // A slanted label is taller than a flat one; the plot moves up for it.
    const bottom = (o: CategoricalOptionLike) => (o.grid as { bottom: number }).bottom;
    expect(bottom(all)).toBeGreaterThan(bottom(plain));
    expect(all.xAxis.nameGap as number).toBeGreaterThan(plain.xAxis.nameGap as number);

    const vertical = buildVisualOption(
      visual({ options: { categoryLabels: "vertical" } }),
      categorical,
    )! as CategoricalOptionLike;
    expect((vertical.xAxis.axisLabel as Record<string, unknown>).rotate).toBe(90);
  });

  it("shows every label on a horizontal bar without slanting it", () => {
    // Down the y axis the labels stack rather than collide, so they are
    // simply all drawn; a slant there would make them harder to read.
    const option = buildVisualOption(
      visual({ type: "hbar", options: { categoryLabels: "all" } }),
      categorical,
    )! as CategoricalOptionLike;
    const label = option.yAxis.axisLabel as Record<string, unknown>;
    expect(label.interval).toBe(0);
    expect(label).not.toHaveProperty("rotate");
  });

  it("returns null for the DOM-rendered types", () => {
    expect(buildVisualOption(visual({ type: "table" }), categorical)).toBeNull();
    expect(buildVisualOption(visual({ type: "kpi" }), categorical)).toBeNull();
  });

  it("shows a legend only for two or more series", () => {
    const one = buildVisualOption(visual({}), categorical)!;
    expect(one.legend.show).toBe(false);
    const twoMetrics: QueryResponse = {
      columns: [
        { name: "REGION", type: "TEXT" },
        { name: "REVENUE", type: "FIXED" },
        { name: "QUANTITY", type: "FIXED" },
      ],
      rows: [["EAST", 10, 1], ["WEST", 20, 2]],
      truncated: false, sfqid: null, sql: "",
    };
    const two = buildVisualOption(
      visual({ wells: { axis: ["C.REGION"], legend: [], values: ["A.REVENUE", "A.QUANTITY"] } }),
      twoMetrics,
    )!;
    expect(two.legend.show).toBe(true);
  });
});

describe("visualTitle", () => {
  it("prefers an explicit title", () => {
    expect(visualTitle(visual({ title: "My tile" }))).toBe("My tile");
  });

  it("composes one from the wells otherwise", () => {
    expect(visualTitle(visual({}))).toBe("REVENUE by REGION");
    expect(visualTitle(visual({ type: "kpi", wells: { value: ["A.REVENUE"] } })))
      .toBe("REVENUE");
  });
});
