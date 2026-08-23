import { describe, expect, it } from "vitest";
import { ageSince, dayStamp } from "./age";

const NOW = new Date("2026-08-22T12:00:00Z");

describe("dayStamp", () => {
  it("always carries the year", () => {
    // relativeTime drops it for the current year, which is right for a
    // Modified column you glance at and wrong for a table you compare down:
    // "Jun 2" beside "Dec 14, 2024" gave no clue they were 18 months apart.
    expect(dayStamp("2026-06-02T00:00:00Z")).toMatch(/2026/);
    expect(dayStamp("2024-12-14T00:00:00Z")).toMatch(/2024/);
  });

  it("says so when there is no date rather than printing an epoch", () => {
    expect(dayStamp(null)).toBe("—");
    expect(dayStamp("not a date")).toBe("—");
  });
});

describe("ageSince", () => {
  it("counts days while days are what a reader is judging", () => {
    expect(ageSince("2026-08-20T12:00:00Z", NOW)).toBe("2 days");
    expect(ageSince("2026-08-21T12:00:00Z", NOW)).toBe("1 day");
  });

  it("calls the same day today", () => {
    expect(ageSince("2026-08-22T09:00:00Z", NOW)).toBe("today");
  });

  it("switches to months once days stop being comparable", () => {
    expect(ageSince("2026-05-22T12:00:00Z", NOW)).toBe("3 mo");
    expect(ageSince("2025-09-22T12:00:00Z", NOW)).toBe("11 mo");
  });

  it("switches to years once months stop being readable", () => {
    // 20 months is the stalest source in a real model, and "20 mo" makes a
    // reader do the division themselves.
    expect(ageSince("2024-12-22T12:00:00Z", NOW)).toBe("1 yr 8 mo");
    expect(ageSince("2025-08-22T12:00:00Z", NOW)).toBe("1 yr");
  });

  it("never reports a negative age from clock skew", () => {
    // A source stamped slightly ahead of the browser must not read
    // "-1 days" in a column about staleness.
    expect(ageSince("2026-08-23T12:00:00Z", NOW)).toBe("today");
  });

  it("has nothing to say about a missing date", () => {
    expect(ageSince(null, NOW)).toBe("—");
  });
});
