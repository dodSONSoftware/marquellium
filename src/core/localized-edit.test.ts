import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import cases from "../../fixtures/markdown/m3v/fidelity-cases.json";
import { createSourceMap, type MappedNode, type SourceRange, type Utf16Offset } from "./source-map";
import { editMappedBlock, editMappedText, prepareLocalizedEdit, type LocalizedEdit } from "./localized-edit";
import { applyOps, bytesToString, stringToBytes } from "./ops";

function setup(text = "Before **bold** after.") {
  const snapshot = { docId: "doc", revision: 3, text };
  const map = createSourceMap(snapshot);
  const block = map.blocks[0]!;
  return { snapshot, map, block };
}
function textLeaf(node: MappedNode, source: string): MappedNode {
  if (node.type === "text" && node.source === source) return node;
  for (const child of node.children) {
    try { return textLeaf(child, source); } catch { /* try the next branch */ }
  }
  throw new Error(`missing test leaf: ${source}`);
}
function unsafeRange(from: number, to: number): SourceRange {
  return { docId: "doc", revision: 3, from: from as Utf16Offset, to: to as Utf16Offset };
}

describe("localized edit preparation", () => {
  it("preserves emphasis and link markers by editing exact source leaves only", () => {
    const { snapshot, map, block } = setup("Before **bold** and [link](url) after.");
    const leaf = textLeaf(block.node, "bold");
    const edit = editMappedText(map, leaf, "bolder");
    const ops = prepareLocalizedEdit(snapshot, edit);
    expect(ops).toEqual([{ startByte: 13, endByte: 13, text: "er" }]);
    const result = applyOps(stringToBytes(snapshot.text), ops);
    expect(result.ok).toBe(true);
    expect(bytesToString(result.next)).toBe("Before **bolder** and [link](url) after.");
    expect(edit.authorizedRange).toEqual(leaf.range);
  });

  it.each([
    ["a🎉z", "a🎊z", 1, 5, "🎊"],
    ["aéz", "aèz", 1, 4, "è"],
    ["a👩‍💻z", "a👩‍🔬z", 1, 12, "👩‍🔬"],
    ["abc", "ac", 1, 2, ""],
    ["abc", "abXc", 2, 2, "X"],
  ])("uses the smallest grapheme-safe operation: %s → %s", (before, after, startByte, endByte, text) => {
    const { snapshot, map, block } = setup(before);
    expect(prepareLocalizedEdit(snapshot, editMappedBlock(map, block, after))).toEqual([{ startByte, endByte, text }]);
  });

  it("returns no operations for an unchanged current request", () => {
    const { snapshot, map, block } = setup();
    expect(prepareLocalizedEdit(snapshot, editMappedBlock(map, block, block.source))).toEqual([]);
  });

  it("rejects stale snapshots, range identities, and mismatched opening text even on no-op", () => {
    const { snapshot, map, block } = setup();
    const original = editMappedBlock(map, block, block.source);
    const edits: LocalizedEdit[] = [
      { ...original, docId: "other" },
      { ...original, baseRevision: 2 },
      { ...original, range: { ...original.range, revision: 2 } },
      { ...original, authorizedRange: { ...original.authorizedRange, docId: "other" } },
      { ...original, openingText: "wrong", replacementText: "wrong" },
    ];
    for (const edit of edits) expect(() => prepareLocalizedEdit(snapshot, edit)).toThrow();
    expect(snapshot.text).toBe(block.source);
  });

  it("rejects inverted, out-of-bounds, fractional and escaping ranges", () => {
    const { snapshot, map, block } = setup();
    const original = editMappedBlock(map, block, "new");
    for (const range of [unsafeRange(-1, 2), unsafeRange(2, 1), unsafeRange(0, 1000), unsafeRange(0.5, 2), unsafeRange(NaN, 2)]) {
      expect(() => prepareLocalizedEdit(snapshot, { ...original, range })).toThrow("unsafe");
    }
    expect(() => prepareLocalizedEdit(snapshot, { ...original, authorizedRange: unsafeRange(1, 2) })).toThrow("escapes");
  });

  it.each(["🎉", "é", "👩‍💻", "\r\n"])("rejects partial grapheme selections: %j", (cluster) => {
    const { snapshot, map, block } = setup("a" + cluster + "z");
    const original = editMappedBlock(map, block, "new");
    expect(() => prepareLocalizedEdit(snapshot, { ...original, range: unsafeRange(1, 2), openingText: snapshot.text.slice(1, 2) })).toThrow("unsafe");
  });

  it("rejects malformed replacement text and new clusters crossing the authorized range", () => {
    const { snapshot, map, block } = setup("ab");
    const original = editMappedBlock(map, block, "\ud800");
    expect(() => prepareLocalizedEdit(snapshot, original)).toThrow("unpaired");
    expect(() => prepareLocalizedEdit(snapshot, {
      ...original, authorizedRange: unsafeRange(1, 1), range: unsafeRange(1, 1), openingText: "", replacementText: "́",
    })).toThrow("outside");
  });

  it("refuses decoded/escaped text, protected syntax and nodes from another map", () => {
    for (const text of ["&amp;", "[[unknown]]", "<b>tag</b>"]) {
      const { map, block } = setup(text);
      expect(() => editMappedText(map, block.node.type === "html" ? block.node : textLeaf(block.node, text), "new")).toThrow();
    }
    const a = setup();
    const b = setup();
    expect(() => editMappedText(a.map, textLeaf(b.block.node, "bold"), "new")).toThrow("another");
    expect(() => editMappedBlock(a.map, b.block, "new")).toThrow("another");
  });

  it("limits table text edits to the content leaf, preserving alignment and escaped neighbors", () => {
    const { snapshot, map, block } = setup("| left | right |\r\n| :--- | ---: |\r\n| a\\|b | plain |\r\n");
    const edit = editMappedText(map, textLeaf(block.node, "plain"), "changed");
    const result = applyOps(stringToBytes(snapshot.text), prepareLocalizedEdit(snapshot, edit));
    expect(bytesToString(result.next)).toBe(snapshot.text.replace("plain", "changed"));
    expect(edit.range.from).toBe(snapshot.text.indexOf("plain"));
  });

  it("explicit Mermaid source replacement preserves fence spelling and surrounding trivia", () => {
    const { snapshot, map } = setup("Before.\r\n\r\n~~~~mermaid title\r\nflowchart LR\r\n A --> B\r\n~~~~\r\n\r\nAfter.");
    const block = map.blocks[1]!;
    const edit = editMappedBlock(map, block, block.source.replace("A --> B", "A --> C"));
    const ops = prepareLocalizedEdit(snapshot, edit);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.text).toBe("C");
    const result = applyOps(stringToBytes(snapshot.text), ops);
    expect(bytesToString(result.next)).toBe(snapshot.text.replace("A --> B", "A --> C"));
  });
});

describe("production localized helpers against independent byte fixtures", () => {
  it.each(cases)("$name", (fixture) => {
    const root = join(__dirname, "../../fixtures/markdown");
    const bytes = readFileSync(join(root, fixture.input));
    const bomLength = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
    const text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(bomLength));
    const { snapshot, map } = setup(text);
    const block = map.blocks.find((b) => b.node.type === fixture.blockType && b.source.includes(fixture.original))!;
    const edit = editMappedBlock(map, block, block.source.replace(fixture.original, fixture.replacement));
    const ops = prepareLocalizedEdit(snapshot, edit);
    expect(ops).toHaveLength(1);
    const result = applyOps(stringToBytes(text), ops);
    expect(result.ok).toBe(true);
    const saved = Buffer.concat([bytes.subarray(0, bomLength), Buffer.from(result.next)]);
    expect(saved).toEqual(readFileSync(join(root, fixture.expected)));
    const op = ops[0]!;
    expect(result.next.subarray(0, op.startByte)).toEqual(new Uint8Array(bytes.subarray(bomLength, bomLength + op.startByte)));
    expect(result.next.subarray(op.startByte + stringToBytes(op.text).length)).toEqual(new Uint8Array(bytes.subarray(bomLength + op.endByte)));
  });
});
