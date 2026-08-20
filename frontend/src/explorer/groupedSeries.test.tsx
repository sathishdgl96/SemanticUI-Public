import { describe, expect, it } from "vitest";
import { buildVisualOption } from "../query/renderers";
import { exploreVisual } from "./vizTypes";
import { addToWell, emptyWells } from "./wells";
import type { QueryResponse } from "../api/types";

/** Two dimensions must draw as grouped, differently-coloured series --
 *  the whole point of dropping a second dimension on a bar. */
describe("two dimensions on a bar", () => {
  const wells = ["C.REGION", "C.SEGMENT"].reduce(
    (w, ref) => addToWell(w, "axis", ref, "dimension"),
    addToWell(emptyWells(), "values", "O.REVENUE", "metric"),
  );

  const result: QueryResponse = {
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

  it("draws one series per value of the second dimension", () => {
    const option = buildVisualOption(exploreVisual("bar", wells), result) as any;
    expect(option.series.map((s: any) => s.name)).toEqual(["RETAIL", "TRADE"]);
  });

  it("gives each category one bar per series, side by side", () => {
    const option = buildVisualOption(exploreVisual("bar", wells), result) as any;
    expect(option.xAxis.data).toEqual(["EUROPE", "ASIA"]);
    expect(option.series[0].data).toEqual([10, 5]);
    expect(option.series[1].data).toEqual([20, 8]);
    // Grouped, not stacked: no series carries a stack key.
    expect(option.series.every((s: any) => !s.stack)).toBe(true);
  });

  it("colours the two series differently", () => {
    const option = buildVisualOption(exploreVisual("bar", wells), result) as any;
    const colours = option.series.map((s: any) => s.itemStyle.color);
    expect(new Set(colours).size).toBe(2);
  });
});
