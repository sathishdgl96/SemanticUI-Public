import { describe, expect, it } from "vitest";
import type { QueryResponse, Visual } from "../../api/types";
import { gaugeOption, treemapOption, funnelOption } from "./proportional";
import { pieOption } from "./pie";

/** A renderer may be handed rows at a finer grain than it draws -- a stale
 *  result from before the visual type changed, or a report whose query was
 *  built elsewhere. Duplicate labels and arbitrary single rows are wrong
 *  answers, not merely untidy ones, so the renderers fold rather than
 *  trusting the row count. */
const OVER_GRAINED: QueryResponse = {
  columns: [
    { name: "REGION", type: "TEXT" },
    { name: "SEGMENT", type: "TEXT" },
    { name: "REVENUE", type: "NUMBER" },
  ],
  rows: [
    ["EUROPE", "RETAIL", 10],
    ["EUROPE", "TRADE", 20],
    ["ASIA", "RETAIL", 5],
    ["ASIA", "TRADE", 8],
  ],
  truncated: false,
  sql: "",
  sfqid: null,
};

function visual(type: string, wells: Record<string, string[]>): Visual {
  return { id: "v1", type, wells, options: {} } as unknown as Visual;
}

const ONE_BY_ONE = { legend: ["C.REGION"], values: ["O.REVENUE"] };

describe("one-dimension visuals fold duplicate labels", () => {
  it("gives a pie one slice per category, totalled", () => {
    const option = pieOption(visual("pie", ONE_BY_ONE), OVER_GRAINED)!;
    expect(option.series[0].data.map((d) => d.name)).toEqual(["EUROPE", "ASIA"]);
    expect(option.series[0].data.map((d) => d.value)).toEqual([30, 13]);
  });

  it("does the same for a treemap", () => {
    const option = treemapOption(visual("treemap", ONE_BY_ONE), OVER_GRAINED)!;
    expect(option.series[0].data.map((d) => d.name)).toEqual(["EUROPE", "ASIA"]);
    expect(option.series[0].data.map((d) => d.value)).toEqual([30, 13]);
  });

  it("and for a funnel", () => {
    const option = funnelOption(visual("funnel", ONE_BY_ONE), OVER_GRAINED)!;
    expect(option.series[0].data.map((d) => d.value)).toEqual([30, 13]);
  });

  it("gives each folded slice its own colour", () => {
    const option = pieOption(visual("pie", ONE_BY_ONE), OVER_GRAINED)!;
    const colours = option.series[0].data.map((d) => d.itemStyle.color);
    expect(new Set(colours).size).toBe(2);
  });
});

describe("a gauge reads the total, not the first row", () => {
  it("sums every row it is given", () => {
    const option = gaugeOption(
      visual("gauge", { value: ["O.REVENUE"] }),
      OVER_GRAINED,
    )!;
    expect(Number(option.series[0].data[0].value)).toBe(43);
  });

  it("sums the target too, so the ratio is not half right", () => {
    const withTarget: QueryResponse = {
      ...OVER_GRAINED,
      columns: [...OVER_GRAINED.columns, { name: "GOAL", type: "NUMBER" }],
      rows: OVER_GRAINED.rows.map((r) => [...r, 25]),
    };
    const option = gaugeOption(
      visual("gauge", { value: ["O.REVENUE"], target: ["O.GOAL"] }),
      withTarget,
    )!;
    expect(option.series[0].max).toBe(100);
  });
});
