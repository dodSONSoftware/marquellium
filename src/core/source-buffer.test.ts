import { expect, it } from "vitest";
import { SourceBuffer } from "./source-buffer";

it.each(["\r\n", "\r", "\n"])("maps editor positions across %j separators without rewriting neighbors", (ending) => {
  const buffer = new SourceBuffer(`😀${ending}target${ending}tail`);
  expect(buffer.normalized).toBe("😀\ntarget\ntail");
  const { next, changes } = buffer.changes([{ fromA: 3, toA: 9, inserted: "changed\nline" }]);
  expect(next.text).toBe(`😀${ending}changed${ending}line${ending}tail`);
  expect(changes[0]?.fromA).toBe(2 + ending.length);
  expect(buffer.editorOffset(buffer.rawOffset(4))).toBe(4);
});
it("preserves each untouched separator in a mixed document", () => {
  const original = "one\r\ntwo\rthree\nfour";
  const buffer = new SourceBuffer(original);
  expect(buffer.changes([{ fromA: 4, toA: 7, inserted: "TWO" }]).next.text).toBe("one\r\nTWO\rthree\nfour");
});
