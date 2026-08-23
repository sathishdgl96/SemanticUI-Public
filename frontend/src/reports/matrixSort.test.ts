import { describe, expect, it } from "vitest";
import { sortTree, type SortableNode } from "./matrixSort";

/** The tree under test carries a value to sort on; SortableNode is
 *  deliberately structural and says nothing about where that comes
 *  from, so the test declares its own. */
interface ValueNode extends SortableNode {
  value: number;
  children: ValueNode[];
}

function node(label: string, value: number, children: ValueNode[] = []): ValueNode {
  return { label, value, children };
}

const TREE: ValueNode[] = [
  node("EUROPE", 30, [node("FRANCE", 10), node("GERMANY", 20)]),
  node("ASIA", 100, [node("JAPAN", 90), node("INDIA", 10)]),
];

const byValue = (n: ValueNode) => n.value;
const byLabel = (n: ValueNode) => n.label;

describe("sortTree", () => {
  it("returns the tree untouched when nothing is sorted", () => {
    expect(sortTree(TREE, null, byValue)).toBe(TREE);
  });

  it("sorts siblings, keeping each child under its own parent", () => {
    const sorted = sortTree(TREE, "desc", byValue);
    expect(sorted.map((n) => n.label)).toEqual(["ASIA", "EUROPE"]);
    // The hierarchy is the point: sorting must not flatten it.
    expect(sorted[0].children.map((n) => n.label)).toEqual(["JAPAN", "INDIA"]);
    expect(sorted[1].children.map((n) => n.label)).toEqual(["GERMANY", "FRANCE"]);
  });

  it("sorts every level ascending too", () => {
    const sorted = sortTree(TREE, "asc", byValue);
    expect(sorted.map((n) => n.label)).toEqual(["EUROPE", "ASIA"]);
    expect(sorted[1].children.map((n) => n.label)).toEqual(["INDIA", "JAPAN"]);
  });

  it("sorts by label when that is the key", () => {
    const sorted = sortTree(TREE, "asc", byLabel);
    expect(sorted.map((n) => n.label)).toEqual(["ASIA", "EUROPE"]);
    expect(sorted[1].children.map((n) => n.label)).toEqual(["FRANCE", "GERMANY"]);
  });

  it("does not mutate the tree it was given", () => {
    const before = TREE.map((n) => n.label);
    sortTree(TREE, "desc", byValue);
    expect(TREE.map((n) => n.label)).toEqual(before);
    expect(TREE[0].children.map((n) => n.label)).toEqual(["FRANCE", "GERMANY"]);
  });

  it("is stable, so equal values keep the order they arrived in", () => {
    const tied = [node("first", 5), node("second", 5), node("third", 5)];
    expect(sortTree(tied, "asc", byValue).map((n) => n.label)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
