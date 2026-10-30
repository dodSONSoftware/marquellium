import { describe, expect, it } from "vitest";
import { diffRange, mapPositions } from "./text-diff";

function applyDiff(oldText: string, c: { from: number; to: number; insert: string }): string {
  return oldText.slice(0, c.from) + c.insert + oldText.slice(c.to);
}

describe("diffRange", () => {
  it("is a no-op for identical texts", () => {
    const c = diffRange("abc", "abc");
    expect(c).toEqual({ from: 0, to: 0, insert: "" });
  });

  it("finds the minimal insertion", () => {
    const c = diffRange("hello world", "hello brave world");
    expect(c).toEqual({ from: 6, to: 6, insert: "brave " });
    expect(applyDiff("hello world", c)).toBe("hello brave world");
  });

  it("finds the minimal deletion", () => {
    const c = diffRange("hello brave world", "hello world");
    expect(c).toEqual({ from: 6, to: 12, insert: "" });
    expect(applyDiff("hello brave world", c)).toBe("hello world");
  });

  it("finds the minimal replacement", () => {
    const c = diffRange("the quick fox", "the slow fox");
    expect(c).toEqual({ from: 4, to: 9, insert: "slow" });
    expect(applyDiff("the quick fox", c)).toBe("the slow fox");
  });

  it("round-trips multibyte content", () => {
    const old = "héllo 世界 🎉 end";
    const c = diffRange(old, old.slice(0, 5) + "X" + old.slice(8));
    expect(applyDiff(old, c)).toBe(old.slice(0, 5) + "X" + old.slice(8));
  });

  it("handles whole-document replacement", () => {
    const c = diffRange("abc", "xyz");
    expect(applyDiff("abc", c)).toBe("xyz");
  });
});

describe("mapPositions", () => {
  it("maps an insertion before the selection", () => {
    // Identical texts: no-op change, selection unchanged.
    const c = diffRange("hello", "hello");
    expect(c).toEqual({ from: 0, to: 0, insert: "" });
    expect(mapPositions(5, c, 1, 3)).toEqual({ from: 1, to: 3 });
    const c2 = diffRange("hello", "Xhello");
    expect(mapPositions(5, c2, 1, 3)).toEqual({ from: 2, to: 4 });
  });

  it("collapses positions inside a deleted region", () => {
    const c = diffRange("abcdef", "acdef");
    // Selection over just the deleted char.
    expect(mapPositions(6, c, 1, 2)).toEqual({ from: 1, to: 1 });
    // Selection spanning the deletion keeps the surviving tail.
    expect(mapPositions(6, c, 1, 5)).toEqual({ from: 1, to: 4 });
  });

  it("clamps to the new document length", () => {
    const c = diffRange("abcdef", "");
    expect(mapPositions(6, c, 5, 6)).toEqual({ from: 0, to: 0 });
  });

  it("keeps anchor ≤ head after mapping a reversed selection", () => {
    const c = diffRange("abcdef", "abXdef");
    // Reversed selection over "def"+end: maps onto "Xdef" region's tail.
    expect(mapPositions(6, c, 6, 3)).toEqual({ from: 3, to: 6 });
  });
});
