import { describe, expect, it, vi } from "vitest";
import { warm } from "./routes";

describe("warm", () => {
  it("settles quietly when a prefetch fails, because nobody asked for it", async () => {
    // A prefetch is speculative: the user hovered, that is all. A chunk that
    // fails to arrive must not surface as an unhandled rejection -- the real
    // navigation will ask again and report properly if it still fails.
    const failing = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(warm(failing)).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalledOnce();
  });

  it("settles when the chunk arrives", async () => {
    await expect(warm(() => Promise.resolve({ default: () => null }))).resolves.toBeUndefined();
  });
});
