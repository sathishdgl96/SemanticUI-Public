import { describe, expect, it } from "vitest";
import { libraryQueryString } from "./library";

describe("libraryQueryString", () => {
  it("omits everything at its default", () => {
    expect(libraryQueryString({})).toBe("");
  });

  it("includes only what was set", () => {
    expect(libraryQueryString({ q: "churn", sort: "name" })).toBe("?q=churn&sort=name");
  });

  it("encodes values that need it", () => {
    expect(libraryQueryString({ q: "a b&c" })).toBe("?q=a+b%26c");
  });

  it("sends favorite only when true", () => {
    expect(libraryQueryString({ favorite: false })).toBe("");
    expect(libraryQueryString({ favorite: true })).toBe("?favorite=true");
  });

  it("treats whitespace-only search as no search", () => {
    expect(libraryQueryString({ q: "   " })).toBe("");
  });

  it("omits the default sort so the cache key stays stable", () => {
    expect(libraryQueryString({ sort: "recent" })).toBe("");
  });
});
