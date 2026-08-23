import { describe, expect, it } from "vitest";
import {
  announceDragCancel, announceDragEnd, announceDragOver, announceDragStart,
} from "./announcements";

describe("announcements", () => {
  it("announces a rejecting drag-over for a metric over Axis", () => {
    expect(announceDragOver("ORDERS.REVENUE", "metric", "axis")).toBe(
      "ORDERS.REVENUE over Axis. Axis accepts dimensions only. This is a metric.",
    );
  });

  it("announces an accepting drag-over for a metric over Values", () => {
    expect(announceDragOver("ORDERS.REVENUE", "metric", "values")).toBe(
      "ORDERS.REVENUE over Values. Values accepts metrics.",
    );
  });

  it("announces a rejecting drag-end for a metric over Axis", () => {
    expect(announceDragEnd("ORDERS.REVENUE", "metric", "axis")).toBe(
      "ORDERS.REVENUE was not added. Axis accepts dimensions only.",
    );
  });

  it("announces an accepting drag-end for a metric over Values", () => {
    expect(announceDragEnd("ORDERS.REVENUE", "metric", "values")).toBe(
      "ORDERS.REVENUE added to Values.",
    );
  });

  it("announces no well when dropped outside any droppable", () => {
    expect(announceDragEnd("ORDERS.REVENUE", "metric", null)).toBe(
      "ORDERS.REVENUE was not added. It was dropped outside any well.",
    );
    expect(announceDragOver("ORDERS.REVENUE", "metric", null)).toBe(
      "ORDERS.REVENUE is no longer over a well.",
    );
  });

  it("announces pickup and cancellation", () => {
    expect(announceDragStart("ORDERS.REVENUE")).toBe("Picked up ORDERS.REVENUE.");
    expect(announceDragCancel()).toBe("Drag cancelled. Nothing was added.");
  });
});
