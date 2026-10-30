/**
 * FR-051: UTF-16 ↔ UTF-8 position mapping. The oracle is direct encoding:
 * the byte offset of code unit i is the UTF-8 length of text[0..i].
 */
import { describe, expect, it } from "vitest";
import { stringToBytes } from "./ops";
import { ByteIndex, changesToByteOps, splitsPair } from "./positions";

function oracle(text: string, i: number): number {
  return stringToBytes(text.slice(0, i)).length;
}

function checkIndex(text: string, index: ByteIndex, label: string): void {
  for (let i = 0; i <= text.length; i++) {
    // Mid-pair indices are the only ones byteOffset may refuse; they are
    // exactly the indices whose oracle offset is not a char boundary.
    const boundary =
      i === 0 ||
      i === text.length ||
      !splitsPair(text, i);
    const got = index.byteOffset(i);
    if (boundary) {
      expect(got, `${label}: i=${i}`).toBe(oracle(text, i));
    } else {
      expect(got, `${label}: i=${i} must be mid-pair`).toBeNull();
    }
  }
}

describe("ByteIndex", () => {
  it("maps ASCII exactly", () => {
    const text = "hello world";
    const idx = new ByteIndex(text);
    checkIndex(text, idx, "ascii");
    expect(idx.totalBytes()).toBe(11);
  });

  it("maps multibyte and surrogate pairs", () => {
    // é (2B), 中 (3B), 👍 (4B/2 units), combined with ASCII.
    const text = "aéb中c👍d";
    const idx = new ByteIndex(text);
    checkIndex(text, idx, "mixed");
    expect(idx.totalBytes()).toBe(stringToBytes(text).length);
    expect(idx.byteOffset(0)).toBe(0);
    expect(idx.byteOffset(text.length)).toBe(stringToBytes(text).length);
    // The low unit of the emoji pair is illegal; both ends are legal.
    const emojiLow = text.indexOf("👍") + 1;
    expect(idx.byteOffset(emojiLow)).toBeNull();
  });

  it("applyChange insert matches the oracle on the new text", () => {
    const text = "abcdef中👍gh";
    const idx = new ByteIndex(text);
    const inserted = "ZÜnïcode 👋 tail";
    const next = text.slice(0, 4) + inserted + text.slice(7);
    idx.sync(next, [{ fromA: 4, toA: 7, inserted }]);
    checkIndex(next, idx, "after-insert");
    expect(idx.totalBytes()).toBe(stringToBytes(next).length);
  });

  it("applyChange delete matches the oracle on the new text", () => {
    const text = "前a👍b中c";
    const idx = new ByteIndex(text);
    const next = text.slice(0, 1) + text.slice(5);
    idx.sync(next, [{ fromA: 1, toA: 5, inserted: "" }]);
    checkIndex(next, idx, "after-delete");
    expect(idx.totalBytes()).toBe(stringToBytes(next).length);
  });

  it("sequential applyChange tracks a typing session", () => {
    // Simulate typing a word after a multibyte prefix, char by char.
    const start = "héllo 世界 ";
    let idx = new ByteIndex(start);
    let text = start;
    for (const ch of "abc🚀def") {
      const before = text;
      text += ch;
      idx.sync(text, [{ fromA: before.length, toA: before.length, inserted: ch }]);
    }
    checkIndex(text, idx, "typed");
  });

  it("survives 1 MB of mixed content", () => {
    let text = "";
    const chunk = "common markdown text with ünïcode and 中文 and an emoji 🎉\n";
    while (text.length < 1_000_000) text += chunk;
    const idx = new ByteIndex(text);
    expect(idx.totalBytes()).toBe(stringToBytes(text).length);
    // Spot-check boundaries across the document.
    for (const i of [0, 1, 7, 1000, 500_000, 999_999, text.length]) {
      const boundary =
        i === 0 || i === text.length || !splitsPair(text, i);
      const got = idx.byteOffset(i);
      if (boundary) expect(got).toBe(oracle(text, i));
      else expect(got).toBeNull();
    }
  });
});

describe("changesToByteOps", () => {
  it("converts ordered changes to valid byte ops", () => {
    // Changes are in order, each against the post-predecessor document
    // (CodeMirror's iterChanges semantics).
    const text = "The quick brown fox.";
    const idx = new ByteIndex(text);
    // CodeMirror orders changes by fromA (ascending, non-overlapping).
    const ops = changesToByteOps(idx, [
      { fromA: 0, toA: 0, inserted: ">> " },
      { fromA: 4, toA: 9, inserted: "slow" },
    ]);
    // op1 addresses the ORIGINAL buffer; op2 (insert at 0) is unaffected by
    // op1's byte shifts because the registry applies ops in order.
    expect(ops).toEqual([
      { startByte: 0, endByte: 0, text: ">> " },
      {
        startByte: stringToBytes(text.slice(0, 4)).length,
        endByte: stringToBytes(text.slice(0, 9)).length,
        text: "slow",
      },
    ]);
  });

  it("returns null when a boundary splits a surrogate pair", () => {
    const text = "ab👍cd";
    const idx = new ByteIndex(text);
    // Index 3 is the low unit of the emoji (pair at 2..4).
    const ops = changesToByteOps(idx, [{ fromA: 2, toA: 3, inserted: "x" }]);
    expect(ops).toBeNull();
  });

  it("returns null for out-of-range boundaries", () => {
    const idx = new ByteIndex("abc");
    expect(
      changesToByteOps(idx, [{ fromA: 0, toA: 4, inserted: "" }]),
    ).toBeNull();
  });
});
