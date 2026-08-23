import { describe, expect, it } from "vitest";
import type { QueryResponse, Visual } from "../../api/types";
import type { CategoricalOptionLike, PieOptionLike } from "./categorical";
import { buildVisualOption } from "./index";

// The folder's option types are a union; each test knows which member it is
// asking for. Same narrowing the existing renderers.test.ts uses.
const pieish = (v: Visual, r: QueryResponse) =>
  buildVisualOption(v, r)! as PieOptionLike;
const cartesian = (v: Visual, r: QueryResponse) =>
  buildVisualOption(v, r)! as CategoricalOptionLike;

function visual(type: string, wells: Record<string, string[]>, options = {}): Visual {
  return {
    id: "v1",
    type,
    title: "",
    layout: { x: 0, y: 0, w: 6, h: 6 },
    wells,
    options,
    filters: [],
  };
}

const BY_REGION: QueryResponse = {
  columns: [
    { name: "REGION", type: "TEXT" },
    { name: "REV", type: "NUMBER" },
  ],
  rows: [
    ["EAST", 30],
    ["WEST", 70],
  ],
  truncated: false,
  sfqid: null,
  sql: "",
};

const ONE_BY_ONE = { legend: ["C.REGION"], values: ["A.REV"] };

describe("proportional renderers", () => {
  it("draws a treemap from one dimension and one measure", () => {
    const option = pieish(visual("treemap", ONE_BY_ONE), BY_REGION);
    expect(option.series[0].type).toBe("treemap");
    expect(option.series[0].data).toHaveLength(2);
    // The tiles carry their own labels, so a legend would say it all twice.
    expect(option.legend.show).toBe(false);
  });

  it("draws a funnel widest-first", () => {
    const option = pieish(visual("funnel", ONE_BY_ONE), BY_REGION);
    expect(option.series[0].type).toBe("funnel");
    expect(option.series[0].sort).toBe("descending");
  });

  it("scales a gauge to its target when one is given", () => {
    const withTarget: QueryResponse = {
      ...BY_REGION,
      columns: [
        { name: "REV", type: "NUMBER" },
        { name: "GOAL", type: "NUMBER" },
      ],
      rows: [[75, 100]],
    };
    const option = pieish(
      visual("gauge", { value: ["A.REV"], target: ["A.GOAL"] }),
      withTarget,
    );
    expect(option.series[0].max).toBe(100);
    // The union covers every series shape in the folder; a gauge's data is
    // always the object form.
    const point = option.series[0].data[0] as unknown as { value: number };
    expect(point.value).toBe(75);
  });

  it("falls back to the value itself when a gauge has no target", () => {
    const single: QueryResponse = {
      ...BY_REGION,
      columns: [{ name: "REV", type: "NUMBER" }],
      rows: [[42]],
    };
    const option = pieish(visual("gauge", { value: ["A.REV"] }), single);
    expect(option.series[0].max).toBe(42);
    // Without a target the scale is arbitrary, so the axis numbers would
    // claim a precision the data does not have.
    const axisLabel = option.series[0].axisLabel as { show: boolean };
    expect(axisLabel.show).toBe(false);
  });

  it("does not draw the measure's name across its own reading", () => {
    // ECharts draws data[].name as a gauge title, and its default sits a
    // hair below the detail -- so the name and the value were painted over
    // each other. The tile header already says what is being measured.
    const single: QueryResponse = {
      ...BY_REGION,
      columns: [{ name: "REV", type: "NUMBER" }],
      rows: [[42]],
    };
    const series = pieish(visual("gauge", { value: ["A.REV"] }), single).series[0];
    expect(series.title as { show: boolean }).toMatchObject({ show: false });
    // Dead centre of the dial: at 10% below it landed on the arc itself
    // once the arc shrank.
    expect((series.detail as { offsetCenter: unknown[] }).offsetCenter).toEqual([
      0,
      "0%",
    ]);
  });

  it("sizes the dial as a fraction of the tile rather than a fixed radius", () => {
    const single: QueryResponse = {
      ...BY_REGION,
      columns: [{ name: "REV", type: "NUMBER" }],
      rows: [[42]],
    };
    const series = pieish(visual("gauge", { value: ["A.REV"] }), single).series[0];
    expect(series.radius).toBe("88%");
    // Low, because the arc opens downwards and the top half is mostly
    // empty.
    expect(series.center).toEqual(["50%", "58%"]);
  });

  it("gives a donut the same option as a pie with the hole set", () => {
    const donut = pieish(visual("donut", ONE_BY_ONE), BY_REGION);
    const pie = pieish(visual("pie", ONE_BY_ONE, { donut: true }), BY_REGION);
    expect(donut.series[0].radius).toEqual(pie.series[0].radius);
  });

  it("returns null for the DOM-rendered types", () => {
    for (const type of ["table", "matrix", "kpi", "multiCard", "slicer"]) {
      expect(buildVisualOption(visual(type, ONE_BY_ONE), BY_REGION)).toBeNull();
    }
  });
});

describe("cartesian variants", () => {
  const CATEGORICAL = { axis: ["C.REGION"], legend: [], values: ["A.REV"] };

  it("puts the categories on the y axis for a horizontal bar", () => {
    const column = cartesian(visual("bar", CATEGORICAL), BY_REGION);
    const bar = cartesian(visual("hbar", CATEGORICAL), BY_REGION);
    expect(column.xAxis.type).toBe("category");
    expect(column.yAxis.type).toBe("value");
    // Same chart, axes exchanged.
    expect(bar.xAxis.type).toBe("value");
    expect(bar.yAxis.type).toBe("category");
    expect(bar.yAxis.data).toEqual(["EAST", "WEST"]);
  });

  it("draws combo's column values as bars and its line values as lines", () => {
    const result: QueryResponse = {
      ...BY_REGION,
      columns: [
        { name: "REGION", type: "TEXT" },
        { name: "REV", type: "NUMBER" },
        { name: "MARGIN", type: "NUMBER" },
      ],
      rows: [
        ["EAST", 30, 4],
        ["WEST", 70, 9],
      ],
    };
    const option = cartesian(
      visual("combo", {
        axis: ["C.REGION"],
        values: ["A.REV"],
        lineValues: ["A.MARGIN"],
      }),
      result,
    );
    expect(option.series.map((s) => s.type)).toEqual(["bar", "line"]);
  });

  it("restates a 100% stacked chart as shares of each category", () => {
    const result: QueryResponse = {
      ...BY_REGION,
      columns: [
        { name: "REGION", type: "TEXT" },
        { name: "A", type: "NUMBER" },
        { name: "B", type: "NUMBER" },
      ],
      rows: [
        ["EAST", 25, 75],
        ["WEST", 10, 10],
      ],
    };
    const option = cartesian(
      visual(
        "bar",
        { axis: ["C.REGION"], legend: [], values: ["A.A", "A.B"] },
        { stacked100: true },
      ),
      result,
    );
    expect(option.series[0].data).toEqual([25, 50]);
    expect(option.series[1].data).toEqual([75, 50]);
    expect(option.yAxis.max).toBe(100);
    // 100% stacking implies stacking.
    expect(option.series[0].stack).toBe("total");
  });

  it("leaves a zero-total category null rather than dividing by zero", () => {
    const result: QueryResponse = {
      ...BY_REGION,
      columns: [
        { name: "REGION", type: "TEXT" },
        { name: "A", type: "NUMBER" },
      ],
      rows: [
        ["EAST", 0],
        ["WEST", 8],
      ],
    };
    const option = cartesian(
      visual("bar", { axis: ["C.REGION"], legend: [], values: ["A.A"] }, { stacked100: true }),
      result,
    );
    expect(option.series[0].data).toEqual([null, 100]);
  });
});
