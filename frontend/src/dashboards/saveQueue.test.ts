import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSaveQueue } from "./saveQueue";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const A = [{ id: "t1", x: 0, y: 0, w: 6, h: 6 }];
const B = [{ id: "t1", x: 6, y: 0, w: 6, h: 6 }];
const C = [{ id: "t1", x: 0, y: 6, w: 6, h: 6 }];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSaveQueue", () => {
  it("coalesces a burst of changes into one write", async () => {
    // react-grid-layout reports a layout change on drag stop AND again from
    // componentDidUpdate. Sending each one separately is what let an older
    // arrangement land after a newer one.
    const save = vi.fn().mockResolvedValue(undefined);
    const queue = createSaveQueue(save, 300);

    queue.push(A);
    queue.push(B);
    queue.push(C);
    await vi.advanceTimersByTimeAsync(300);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(C);
  });

  it("never has two writes in flight at once", async () => {
    // The whole bug: concurrent PUTs of the same document, where which one
    // the server commits last is a race the client cannot see.
    const first = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const queue = createSaveQueue(save, 300);

    queue.push(A);
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledTimes(1);

    queue.push(B);
    await vi.advanceTimersByTimeAsync(300);
    // Still one: the second is held until the first answers.
    expect(save).toHaveBeenCalledTimes(1);

    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(B);
  });

  it("sends only the newest layout when several queue behind one write", async () => {
    const first = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const queue = createSaveQueue(save, 300);

    queue.push(A);
    await vi.advanceTimersByTimeAsync(300);
    queue.push(B);
    queue.push(C);
    first.resolve();
    await vi.advanceTimersByTimeAsync(300);

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(C);
  });

  it("ignores a layout identical to the one already saved", async () => {
    // The grid reports its layout on mount, which is not an edit. Writing it
    // back cost a request per page view.
    const save = vi.fn().mockResolvedValue(undefined);
    const queue = createSaveQueue(save, 300);

    queue.push(A);
    await vi.advanceTimersByTimeAsync(300);
    queue.push([...A]);
    await vi.advanceTimersByTimeAsync(300);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not write at all when the first layout matches what was loaded", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const queue = createSaveQueue(save, 300, A);

    queue.push([...A]);
    await vi.advanceTimersByTimeAsync(300);

    expect(save).not.toHaveBeenCalled();
  });

  it("keeps accepting changes after a failed write", async () => {
    // A dropped connection must not wedge the queue: the next drag has to
    // still reach the server.
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const queue = createSaveQueue(save, 300);

    queue.push(A);
    await vi.advanceTimersByTimeAsync(300);
    queue.push(B);
    await vi.advanceTimersByTimeAsync(300);

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(B);
  });

  it("retries the same layout after a failure if nothing newer arrived", async () => {
    // Otherwise a single failed write silently loses the arrangement, which
    // is the complaint this whole queue exists to answer.
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const queue = createSaveQueue(save, 300);

    queue.push(A);
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(A);
  });

  it("stops retrying once it is torn down", async () => {
    const save = vi.fn().mockRejectedValue(new Error("offline"));
    const queue = createSaveQueue(save, 300);

    queue.push(A);
    await vi.advanceTimersByTimeAsync(300);
    queue.dispose();
    await vi.advanceTimersByTimeAsync(5000);

    expect(save).toHaveBeenCalledTimes(1);
  });
});
