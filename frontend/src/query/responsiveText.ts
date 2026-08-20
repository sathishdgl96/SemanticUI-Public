/** Chart text that tracks the size of the chart.
 *
 *  ECharts resizes its geometry to the container and leaves every label at
 *  the size it was told. A tile dragged small therefore kept 12px axis
 *  labels and an 11px legend around a chart with barely room for the
 *  plot -- text and picture at different scales, which is the thing that
 *  makes a small tile look broken rather than small.
 *
 *  Applied to the finished option rather than inside each renderer, so it
 *  covers bar, line, pie, funnel, gauge and scatter without any of them
 *  knowing it exists.
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
export function scaleOption<T extends Record<string, unknown>>(option: T, box: Box): T {
  const scale = textScale(box);
  const scaled = walk(option, scale) as Record<string, unknown>;

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
