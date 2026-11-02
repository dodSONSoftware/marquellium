/** Package A oracles only: no Visual adapter, serializers, or canonical writes. */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import cases from "../../../fixtures/markdown/m3v/fidelity-cases.json";
import { createSourceMap, type MappedNode } from "../../core/source-map";
import { applyOps, stringToBytes } from "../../core/ops";
import { ByteIndex } from "../../core/positions";

const root = join(__dirname, "../../../fixtures/markdown");
function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith(".md") ? [path] : [];
  });
}
function canonical(file: string) {
  const bytes = readFileSync(file);
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(bom ? 3 : 0));
  return { bytes, bom, text };
}
function checkNode(node: MappedNode, text: string, from: number, to: number): void {
  expect(node.range.from).toBeGreaterThanOrEqual(from);
  expect(node.range.to).toBeLessThanOrEqual(to);
  expect(node.source).toBe(text.slice(node.range.from, node.range.to));
  for (const child of node.children) checkNode(child, text, node.range.from, node.range.to);
}

describe("mapping fidelity across the complete Markdown corpus", () => {
  it.each(markdownFiles(root))("reconstructs raw bytes from revision-bound segments: %s", (file) => {
    const { bytes, text, bom } = canonical(file);
    const map = createSourceMap({ docId: file, revision: 12, text });
    let cursor = 0;
    for (const segment of map.segments) {
      expect(segment.range.from).toBe(cursor);
      cursor = segment.range.to;
      if (segment.kind === "block") checkNode(segment.node, text, segment.range.from, segment.range.to);
    }
    expect(cursor).toBe(text.length);
    const reconstructed = Buffer.concat([
      bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
      Buffer.from(map.segments.map((segment) => segment.source).join(""), "utf8"),
    ]);
    expect(reconstructed.equals(bytes)).toBe(true);
  });
});

describe("independent localized-edit byte oracles for later packages", () => {
  it.each(cases)("$name", (fixture) => {
    const input = canonical(join(root, fixture.input));
    const expected = readFileSync(join(root, fixture.expected));
    const map = createSourceMap({ docId: fixture.input, revision: 4, text: input.text });
    const targets = map.blocks.filter((block) => block.node.type === fixture.blockType && block.source.includes(fixture.original));
    expect(targets).toHaveLength(1);
    const target = targets[0]!;
    const localStart = target.source.indexOf(fixture.original);
    expect(target.source.indexOf(fixture.original, localStart + 1)).toBe(-1);
    const from = target.range.from + localStart;
    const to = from + fixture.original.length;
    expect(to).toBeLessThanOrEqual(target.range.to);
    const index = new ByteIndex(input.text);
    const startByte = index.byteOffset(from);
    const endByte = index.byteOffset(to);
    if (startByte === null || endByte === null) throw new Error("invalid fixture boundary");
    // The manifest specifies this test operation, not a production edit adapter.
    const original = stringToBytes(input.text);
    const result = applyOps(original, [{ startByte, endByte, text: fixture.replacement }]);
    expect(result.ok).toBe(true);
    expect(result.next.subarray(0, startByte)).toEqual(original.subarray(0, startByte));
    expect(result.next.subarray(startByte + stringToBytes(fixture.replacement).length)).toEqual(original.subarray(endByte));
    const saved = Buffer.concat([input.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(result.next)]);
    expect(saved.equals(expected)).toBe(true);
    expect(map.snapshot.text).toBe(input.text);
    expect(map.snapshot.revision).toBe(4);
  });
});
