import { describe, expect, it } from "vitest";
import { exactTime, relativeTime } from "./relativeTime";

/** A fixed local noon, so every case below is read against the same clock
 *  wherever the suite runs. */
const NOW = new Date(2026, 7, 20, 12, 0, 0);
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("calls the last minute just now", () => {
    expect(relativeTime(ago(5_000), NOW)).toBe("just now");
    expect(relativeTime(ago(59_000), NOW)).toBe("just now");
  });

  it("counts minutes, then hours", () => {
    expect(relativeTime(ago(5 * MINUTE), NOW)).toBe("5 min ago");
    expect(relativeTime(ago(HOUR), NOW)).toBe("1 hour ago");
    expect(relativeTime(ago(3 * HOUR), NOW)).toBe("3 hours ago");
  });

  it("says yesterday rather than counting the hours across midnight", () => {
    // 20 hours before noon is 4pm the previous day: "20 hours ago" is
    // arithmetically right and reads as the wrong day.
    expect(relativeTime(ago(20 * HOUR), NOW)).toBe("yesterday");
  });

  it("counts days up to a week", () => {
    expect(relativeTime(ago(3 * DAY), NOW)).toBe("3 days ago");
    expect(relativeTime(ago(6 * DAY), NOW)).toBe("6 days ago");
  });

  it("gives a date past a week, because '37 days ago' is worse than a date", () => {
    const older = relativeTime(ago(40 * DAY), NOW);
    expect(older).toMatch(/Jul/);
    expect(older).not.toMatch(/ago/);
  });

  it("adds the year only when it is not this one", () => {
    expect(relativeTime(ago(40 * DAY), NOW)).not.toMatch(/2026/);
    expect(relativeTime(ago(400 * DAY), NOW)).toMatch(/2025/);
  });

  it("never reads as the future when the server clock runs ahead", () => {
    const ahead = new Date(NOW.getTime() + 3 * MINUTE).toISOString();
    expect(relativeTime(ahead, NOW)).toBe("just now");
  });

  it("says nothing rather than Invalid Date", () => {
    expect(relativeTime("not-a-date", NOW)).toBe("—");
    expect(exactTime("not-a-date")).toBe("");
  });
});
