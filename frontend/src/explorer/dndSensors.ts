import { KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";

// Space alone activates a keyboard drag pickup; Enter is deliberately left
// out of `start`/`end` so dnd-kit's KeyboardSensor never calls
// preventDefault() on an Enter keydown over a field row. That lets the
// browser's native button-activation behavior fire the row's `onClick`
// (add to the default well) on Enter, keeping it a real, one-step,
// keyboard-only path that never requires a drag.
const KEYBOARD_CODES = { start: ["Space"], cancel: ["Escape"], end: ["Space"] };

// Exported as a hook (rather than inlined per-component) so ExplorerPage
// and its tests share one source of truth for the sensor config — a test
// asserting keyboard behavior can't silently drift from what production
// actually configures.
export function useFieldSensors() {
  return useSensors(
    // `distance: 8` keeps PointerSensor from hijacking a plain click on a
    // field row (mousedown+mouseup with no movement) as a drag start, so
    // click-to-add stays a real, independent path from dragging.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { keyboardCodes: KEYBOARD_CODES }),
  );
}
