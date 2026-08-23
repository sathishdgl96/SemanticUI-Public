import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  REFERENCE,
  scaleOption,
  textScale,
} from "./responsiveOption";

describe("textScale", () => {
  it("leaves a reference-sized tile alone", () => {
    expect(textScale(REFERENCE)).toBe(1);
  });

  it("shrinks with the smaller of the two dimensions", () => {
    // A tile that is wide and short has as little room for a stack of
    // legend entries as a narrow one has for long axis labels.
    const wideAndShort = { width: REFERENCE.width * 2, height: REFERENCE.height / 2 };
    expect(textScale(wideAndShort)).toBeCloseTo(0.5 > MIN_SCALE ? 0.5 : MIN_SCALE);
  });

  it("stops shrinking before the text stops being text", () => {
    expect(textScale({ width: 20, height: 20 })).toBe(MIN_SCALE);
  });

  it("stops growing before an axis becomes a headline", () => {
    expect(textScale({ width: 4000, height: 3000 })).toBe(MAX_SCALE);
  });

  it("treats an unmeasured box as reference-sized", () => {
    // A chart is measured after it mounts; before that, the honest answer
    // is "no reason to change anything".
    expect(textScale({ width: 0, height: 0 })).toBe(1);
  });
});

describe("scaleOption", () => {
  const small = { width: 210, height: 150 };

  it("scales a size wherever a renderer set one", () => {
    // By shape, not by a list of known keys: ECharts puts fontSize under
    // textStyle, label, axisLabel, detail, nameTextStyle and a dozen more.
    const option = {
      xAxis: { axisLabel: { fontSize: 12 } },
      series: [{ label: { fontSize: 14 }, detail: { fontSize: 20 } }],
    };
    const out = scaleOption(option, small);
    expect(out.xAxis.axisLabel.fontSize).toBeLessThan(12);
    expect(out.series[0].label.fontSize).toBeLessThan(14);
    expect(out.series[0].detail.fontSize).toBeLessThan(20);
  });

  it("carries the scale to text no renderer named a size for", () => {
    // Most labels never name a size, so scaling only the explicit ones
    // would leave the majority of the text fixed.
    const out: Record<string, unknown> = scaleOption({ series: [] }, small);
    expect((out.textStyle as { fontSize: number }).fontSize).toBeLessThan(12);
  });

  it("keeps a root text size the caller chose deliberately", () => {
    const out = scaleOption({ textStyle: { fontSize: 18 } }, small);
    // Scaled by the walk, then left alone rather than overwritten.
    expect((out.textStyle as { fontSize: number }).fontSize).toBeLessThan(18);
  });

  it("never renders text too small to be text", () => {
    const out = scaleOption({ xAxis: { axisLabel: { fontSize: 9 } } }, { width: 30, height: 30 });
    expect(out.xAxis.axisLabel.fontSize).toBeGreaterThanOrEqual(8);
  });

  it("drops the legend from a tile with no room for one", () => {
    const out = scaleOption({ legend: { show: true, bottom: 0 } }, small);
    expect(out.legend).toMatchObject({ show: false, bottom: 0 });
  });

  it("does not grow a legend onto a chart that declared none", () => {
    const out: Record<string, unknown> = scaleOption(
      { series: [] },
      { width: 900, height: 700 },
    );
    expect(out.legend).toBeUndefined();
  });

  it("leaves a roomy tile's legend showing", () => {
    const out = scaleOption({ legend: { show: true } }, { width: 600, height: 420 });
    expect(out.legend).toMatchObject({ show: true });
  });

  it("brings the plot's own margins in with the tile", () => {
    // On a short tile a 16px top and a 48px bottom are two thirds of the
    // height before anything is drawn.
    const out = scaleOption(
      { grid: { left: 56, right: 16, top: 16, bottom: 48 } },
      small,
    );
    expect(out.grid.left).toBeLessThan(56);
    expect(out.grid.bottom).toBeLessThan(48);
    expect(out.grid.right).toBeGreaterThanOrEqual(8);
  });

  it("leaves a margin given as a percentage alone", () => {
    // Those already adapt; scaling them would shrink twice.
    const out = scaleOption({ grid: { left: "10%", bottom: 40 } }, small);
    expect(out.grid.left).toBe("10%");
  });

  it("shrinks a gauge's band, its label distance and its marker", () => {
    // A gauge's arc is a percentage and its band is pixels, so shrinking
    // the tile shrank the arc and left the band lying across it.
    const out = scaleOption(
      {
        series: [
          {
            type: "gauge",
            progress: { show: true, width: 14 },
            axisLine: { lineStyle: { width: 14, color: [[1, "#eee"]] } },
            axisLabel: { show: true, distance: 18 },
          },
        ],
      },
      small,
    );
    const gauge = out.series[0];
    expect(gauge.progress.width).toBeLessThan(14);
    expect(gauge.axisLine.lineStyle.width).toBeLessThan(14);
    expect(gauge.axisLabel.distance).toBeLessThan(18);
    // Everything else about the series survives.
    expect(gauge.axisLine.lineStyle.color).toEqual([[1, "#eee"]]);
    expect(gauge.progress.show).toBe(true);
  });

  it("keeps a gauge's band thick enough to see", () => {
    const out = scaleOption(
      { series: [{ type: "gauge", progress: { width: 6 } }] },
      { width: 40, height: 40 },
    );
    expect(out.series[0].progress.width).toBeGreaterThanOrEqual(4);
  });

  it("brings a funnel's margins in too", () => {
    const out = scaleOption(
      { series: [{ type: "funnel", top: 16, bottom: 40 }] },
      small,
    );
    expect(out.series[0].top).toBeLessThanOrEqual(16);
    expect(out.series[0].bottom).toBeLessThan(40);
  });

  it("shrinks a scatter marker but never to a smudge", () => {
    expect(scaleOption({ series: [{ symbolSize: 9 }] }, small).series[0].symbolSize)
      .toBeLessThan(9);
    expect(
      scaleOption({ series: [{ symbolSize: 5 }] }, { width: 30, height: 30 }).series[0]
        .symbolSize,
    ).toBeGreaterThanOrEqual(4);
  });

  it("leaves a series that carries no pixel geometry untouched", () => {
    const out = scaleOption(
      { series: [{ type: "pie", radius: ["45%", "70%"], data: [{ value: 1 }] }] },
      small,
    );
    expect(out.series[0].radius).toEqual(["45%", "70%"]);
    expect(out.series[0].data).toEqual([{ value: 1 }]);
  });

  it("adds no grid or series to an option that declared none", () => {
    const out: Record<string, unknown> = scaleOption({ legend: { show: true } }, small);
    expect("grid" in out).toBe(false);
    expect("series" in out).toBe(false);
  });

  it("does not mutate what it was given", () => {
    const option = { xAxis: { axisLabel: { fontSize: 12 } } };
    scaleOption(option, small);
    expect(option.xAxis.axisLabel.fontSize).toBe(12);
  });

  it("carries arrays through unharmed", () => {
    const out = scaleOption(
      { series: [{ data: [1, 2, 3], name: "Revenue" }] },
      REFERENCE,
    );
    expect(out.series[0].data).toEqual([1, 2, 3]);
    expect(out.series[0].name).toBe("Revenue");
  });
});
