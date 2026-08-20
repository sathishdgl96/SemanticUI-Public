/** A chart option, sized for the box it is about to be drawn in.
 *
 *  ECharts scales what it DRAWS to the container and leaves everything it
 *  was told in pixels exactly where it was: font sizes, grid insets, a
 *  gauge's band width, a funnel's margins. On a small tile that is what
 *  produces a 48px axis gutter in a 150px-tall plot and a gauge whose
 *  reading sits on top of its own arc -- text and picture at different
 *  scales, which is what makes a small tile look broken rather than small.
 *
 *  Applied to the finished option rather than inside each renderer, so it
 *  covers bar, line, pie, funnel, gauge, treemap and scatter without any
 *  of them knowing it exists. Sizes a renderer chose -- including one a
 *  reader chose in the Format pane -- are treated as a PREFERENCE: honoured
 *  where there is room, brought down where there is not.
 */

export interface Box {
  width: number;
  height: number;
}

/** The tile the sizes in the renderers were chosen against. */
export const REFERENCE: Box = { width: 420, height: 300 };

/** Small enough to still be text; large enough that a full-screen tile
 *  does not turn its axis into a headline. */
export const MIN_SCALE = 0.68;
export const MAX_SCALE = 1.2;

/** Below this a legend is taking room the chart itself needs, and is
 *  unreadable in what it takes. */
const LEGEND_FLOOR: Box = { width: 220, height: 170 };

/** Nothing smaller than this is worth rendering as text. */
const MIN_FONT = 8;
/** A gutter narrower than this cannot hold an axis label anyway, and one
 *  wider than the plot is the bug being fixed. */
const MIN_INSET = 8;
const MAX_FONT = 24;
/** ECharts' own default, applied wherever a renderer set nothing. */
const DEFAULT_FONT = 12;

export function textScale(box: Box): number {
  if (!box.width || !box.height) return 1;
  // The SMALLER of the two ratios: a tile that is wide and short has as
  // little room for a tall stack of legend entries as a narrow one has for
  // long axis labels.
  const ratio = Math.min(box.width / REFERENCE.width, box.height / REFERENCE.height);
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, ratio));
}

function scaleFont(value: number, scale: number): number {
  return Math.round(Math.min(MAX_FONT, Math.max(MIN_FONT, value * scale)));
}

/** Walk an option tree, scaling every font size a renderer set explicitly.
 *
 *  By shape rather than by a list of known keys: ECharts puts `fontSize`
 *  under textStyle, label, axisLabel, nameTextStyle, detail, title and a
 *  dozen more, and a list of them would be wrong the first time a renderer
 *  used one that was not on it. */
function walk(value: unknown, scale: number): unknown {
  if (Array.isArray(value)) return value.map((entry) => walk(entry, scale));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "fontSize" && typeof entry === "number") {
      out[key] = scaleFont(entry, scale);
    } else {
      out[key] = walk(entry, scale);
    }
  }
  return out;
}

/**
 * The same option, sized for the box it is about to be drawn in.
 *
 * A root `textStyle` carries the scale to everything the renderers left
 * alone -- most labels never name a size, so scaling only the explicit
 * ones would leave the majority of the text fixed.
 */
/** Scale a pixel measurement that is not a font: a grid inset, a gauge's
 *  band, a scatter marker. Rounded, floored, and left alone when it was
 *  given as a percentage string -- those already adapt. */
function scalePx(value: unknown, scale: number, floor: number): unknown {
  if (typeof value !== "number") return value;
  return Math.max(floor, Math.round(value * scale));
}

/** The plot's own margins. On a short tile a 16px top and a 48px bottom
 *  are two thirds of the height before anything is drawn. */
function scaleGrid(grid: unknown, scale: number): unknown {
  if (!grid || typeof grid !== "object" || Array.isArray(grid)) return grid;
  const out = { ...(grid as Record<string, unknown>) };
  for (const side of ["left", "right", "top", "bottom"]) {
    out[side] = scalePx(out[side], scale, MIN_INSET);
  }
  return out;
}

/**
 * Per-series geometry that ECharts takes in pixels.
 *
 * A gauge is the one that fails loudly: its band width, its axis-label
 * distance and its reading are all pixels around an arc that is a
 * percentage, so shrinking the tile shrinks the arc and leaves a 14px
 * band and a 22px number sitting across it.
 */
function scaleSeries(series: unknown, scale: number): unknown {
  if (!Array.isArray(series)) return series;
  return series.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const out = { ...(entry as Record<string, unknown>) };

    if (out.type === "gauge") {
      if (out.progress && typeof out.progress === "object") {
        const progress = out.progress as Record<string, unknown>;
        out.progress = { ...progress, width: scalePx(progress.width, scale, 4) };
      }
      const axisLine = out.axisLine as Record<string, unknown> | undefined;
      const lineStyle = axisLine?.lineStyle as Record<string, unknown> | undefined;
      if (lineStyle) {
        out.axisLine = {
          ...axisLine,
          lineStyle: { ...lineStyle, width: scalePx(lineStyle.width, scale, 4) },
        };
      }
      const axisLabel = out.axisLabel as Record<string, unknown> | undefined;
      if (axisLabel) {
        out.axisLabel = {
          ...axisLabel,
          distance: scalePx(axisLabel.distance, scale, 4),
        };
      }
    }

    if (out.type === "funnel") {
      out.top = scalePx(out.top, scale, MIN_INSET);
      out.bottom = scalePx(out.bottom, scale, MIN_INSET);
    }

    // A marker below about four pixels is a smudge, not a point.
    out.symbolSize = scalePx(out.symbolSize, scale, 4);
    return out;
  });
}

export function scaleOption<T extends Record<string, unknown>>(option: T, box: Box): T {
  const scale = textScale(box);
  const scaled = walk(option, scale) as Record<string, unknown>;
  // Assigned only when present: writing `grid: undefined` onto a pie
  // option adds a key that was deliberately absent.
  if (scaled.grid) scaled.grid = scaleGrid(scaled.grid, scale);
  if (scaled.series) scaled.series = scaleSeries(scaled.series, scale);

  const rootText = (scaled.textStyle ?? {}) as Record<string, unknown>;
  scaled.textStyle = {
    ...rootText,
    fontSize:
      typeof rootText.fontSize === "number"
        ? rootText.fontSize
        : scaleFont(DEFAULT_FONT, scale),
  };

  // A legend is hidden, never shown, by this: a chart that declares none
  // must not grow one because it happens to be large.
  if (
    scaled.legend &&
    (box.width < LEGEND_FLOOR.width || box.height < LEGEND_FLOOR.height)
  ) {
    scaled.legend = { ...(scaled.legend as Record<string, unknown>), show: false };
  }

  return scaled as T;
}
