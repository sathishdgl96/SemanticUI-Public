import type { ModelLayout } from "./layout";

export interface Viewport {
  scale: number;
  x: number;
  y: number;
}

/** Below this the labels are unreadable; above it a node fills the pane. */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 2.5;
export const IDENTITY: Viewport = { scale: 1, x: 0, y: 0 };

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * The viewport that fits the whole diagram in the pane, centred.
 *
 * Never magnifies past 1: a two-table model blown up to fill a wide
 * screen looks broken rather than generous.
 */
export function fitTo(
  layout: ModelLayout,
  pane: { width: number; height: number },
): Viewport {
  if (layout.width <= 0 || layout.height <= 0) return IDENTITY;
  if (pane.width <= 0 || pane.height <= 0) return IDENTITY;
  const scale = clampScale(
    Math.min(pane.width / layout.width, pane.height / layout.height, 1),
  );
  return {
    scale,
    x: (pane.width - layout.width * scale) / 2,
    y: (pane.height - layout.height * scale) / 2,
  };
}

/**
 * Zoom about a fixed point in pane coordinates.
 *
 * The point under the cursor must stay under the cursor, or zooming
 * walks the diagram off screen and feels like it is fighting you.
 */
export function zoomAbout(
  viewport: Viewport,
  factor: number,
  point: { x: number; y: number },
): Viewport {
  const scale = clampScale(viewport.scale * factor);
  if (scale === viewport.scale) return viewport;
  const ratio = scale / viewport.scale;
  return {
    scale,
    x: point.x - (point.x - viewport.x) * ratio,
    y: point.y - (point.y - viewport.y) * ratio,
  };
}

export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return { ...viewport, x: viewport.x + dx, y: viewport.y + dy };
}

/** Pane coordinates to diagram coordinates, for dragging a node: a drag
 *  of 10 screen pixels at half zoom is 20 diagram units. */
export function toDiagram(
  viewport: Viewport,
  point: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: (point.x - viewport.x) / viewport.scale,
    y: (point.y - viewport.y) / viewport.scale,
  };
}
