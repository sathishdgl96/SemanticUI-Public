/**
 * A colour per member view, so a table's origin is readable at a glance.
 *
 * Assigned by the member's position in the model rather than by hashing
 * its alias: a hash gives two adjacent views adjacent hues often enough
 * to matter, and renaming a view would silently recolour half the canvas.
 * Position is stable across renders and across reloads, and only changes
 * when somebody reorders the model — which is a thing they did on purpose.
 *
 * Colour is never the only signal. Every backdrop carries its alias as a
 * label, because a colour-blind reader gets nothing from the fill.
 */

export interface ViewColour {
  /** The backdrop fill — low alpha, so table cards stay readable on it. */
  wash: string;
  /** The backdrop border and the card's header stripe. */
  ink: string;
}

/**
 * Eight, matching the model's member cap, so no model ever repeats one.
 *
 * Chosen for separation in hue rather than for prettiness, and kept away
 * from the reds the product already uses for danger — a view should not
 * read as a warning.
 */
export const PALETTE: ViewColour[] = [
  { wash: "rgba(76, 110, 245, 0.08)", ink: "#4c6ef5" }, // indigo
  { wash: "rgba(16, 152, 173, 0.08)", ink: "#1098ad" }, // teal
  { wash: "rgba(130, 92, 209, 0.08)", ink: "#825cd1" }, // violet
  { wash: "rgba(12, 143, 90, 0.08)", ink: "#0c8f5a" }, // green
  { wash: "rgba(191, 122, 0, 0.08)", ink: "#bf7a00" }, // amber
  { wash: "rgba(28, 126, 214, 0.08)", ink: "#1c7ed6" }, // blue
  { wash: "rgba(158, 92, 132, 0.08)", ink: "#9e5c84" }, // mauve
  { wash: "rgba(90, 106, 122, 0.08)", ink: "#5a6a7a" }, // slate
];

/** alias (lower-cased) -> colour, by the order members appear. */
export function paletteFor(aliases: string[]): Map<string, ViewColour> {
  const out = new Map<string, ViewColour>();
  aliases.forEach((alias, index) => {
    // Wraps rather than running out. The model caps members at eight, so
    // in practice this never repeats -- but a cap that moves should not
    // take the canvas with it.
    out.set(alias.toLowerCase(), PALETTE[index % PALETTE.length]);
  });
  return out;
}

/** The colour for one alias, or the last in the palette as a neutral
 *  fallback so a stray reference still renders as *something*. */
export function colourOf(
  palette: Map<string, ViewColour>,
  alias: string,
): ViewColour {
  return palette.get(alias.toLowerCase()) ?? PALETTE[PALETTE.length - 1];
}
