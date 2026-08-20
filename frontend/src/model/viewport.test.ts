import { describe, expect, it } from "vitest";
import {
  clampScale, fitTo, IDENTITY, MAX_SCALE, MIN_SCALE, panBy, toDiagram, zoomAbout,
} from "./viewport";
import type { ModelLayout } from "./layout";

const LAYOUT: ModelLayout = { nodes: [], edges: [], width: 400, height: 200 };

describe("clampScale", () => {
  it("holds the readable range", () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1.5)).toBe(1.5);
  });
});

describe("fitTo", () => {
  it("scales down to fit and centres what is left over", () => {
    const view = fitTo(LAYOUT, { width: 200, height: 200 });
    expect(view.scale).toBe(0.5);
    expect(view.x).toBe(0);          // 400 * 0.5 fills the width exactly
    expect(view.y).toBe(50);         // 200 * 0.5 = 100, centred in 200
  });

  it("never magnifies a small model to fill a big screen", () => {
    expect(fitTo(LAYOUT, { width: 4000, height: 2000 }).scale).toBe(1);
  });

  it("is the identity when there is nothing to fit or nowhere to fit it", () => {
    expect(fitTo({ ...LAYOUT, width: 0, height: 0 }, { width: 100, height: 100 }))
      .toEqual(IDENTITY);
    // jsdom reports a zero-sized pane; fitting into it must not divide by it.
    expect(fitTo(LAYOUT, { width: 0, height: 0 })).toEqual(IDENTITY);
  });
});

describe("zoomAbout", () => {
  it("keeps the point under the cursor under the cursor", () => {
    const point = { x: 120, y: 80 };
    const before = toDiagram(IDENTITY, point);
    const zoomed = zoomAbout(IDENTITY, 2, point);
    expect(toDiagram(zoomed, point)).toEqual(before);
  });

  it("refuses to go past the limits, and does not drift when it stops", () => {
    const atMax = { scale: MAX_SCALE, x: 10, y: 10 };
    expect(zoomAbout(atMax, 2, { x: 0, y: 0 })).toEqual(atMax);
  });
});

describe("panBy", () => {
  it("moves without rescaling", () => {
    expect(panBy({ scale: 0.5, x: 10, y: 20 }, 5, -5)).toEqual({
      scale: 0.5, x: 15, y: 15,
    });
  });
});

describe("toDiagram", () => {
  it("undoes the viewport transform", () => {
    const view = { scale: 2, x: 30, y: 10 };
    expect(toDiagram(view, { x: 130, y: 110 })).toEqual({ x: 50, y: 50 });
  });
});
