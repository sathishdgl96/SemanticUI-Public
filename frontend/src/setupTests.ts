import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

// React Flow measures its pane and its nodes before it will draw them, and
// jsdom implements none of the three APIs it measures with. Without these
// it renders an empty canvas and every diagram assertion fails for a
// reason that has nothing to do with the diagram.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (typeof globalThis.DOMMatrixReadOnly === "undefined") {
  globalThis.DOMMatrixReadOnly = class {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
      this.m22 = scale === undefined ? 1 : +scale;
    }
  } as unknown as typeof DOMMatrixReadOnly;
}

// jsdom reports every element as zero-sized, which React Flow reads as
// "not laid out yet". A fixed non-zero box is enough for it to proceed.
for (const property of ["offsetHeight", "offsetWidth"] as const) {
  if (Object.getOwnPropertyDescriptor(HTMLElement.prototype, property)?.get) continue;
  Object.defineProperty(HTMLElement.prototype, property, {
    configurable: true,
    get() {
      return property === "offsetHeight" ? 800 : 1200;
    },
  });
}
