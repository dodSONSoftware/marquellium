import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createSourceMap, assertCurrentSourceMap, navigationAnchor, type MappedNode } from "./source-map";
import { ByteIndex } from "./positions";

const snapshot = (text: string, revision = 0, docId = "doc") => ({ docId, revision, text });
function leaves(node: MappedNode): MappedNode[] {
  return node.type === "text" ? [node] : node.children.flatMap(leaves);
}

describe("raw source mapping", () => {
  it("retains the reader dialect before rendering transforms", () => {
    const text = readFileSync(new URL("../../fixtures/markdown/m3v/mapping.md", import.meta.url), "utf8");
    const map = createSourceMap(snapshot(text));
    expect(map.blocks.map((b) => b.node.type)).toEqual([
      "yaml", "heading", "paragraph", "paragraph", "paragraph", "table", "code", "math", "html", "paragraph", "blockquote", "paragraph", "paragraph", "paragraph", "list",
    ]);
    expect(map.blocks.find((b) => b.node.type === "table")?.capability).toBe("table-candidate");
    expect(map.blocks.find((b) => b.node.type === "code")?.capability).toBe("mermaid-draft");
    for (const type of ["yaml", "math", "html", "blockquote"]) {
      expect(map.blocks.find((b) => b.node.type === type)?.capability).toBe("protected");
    }
    for (const type of ["list"]) expect(map.blocks.find((b) => b.node.type === type)?.capability).toBe("text-candidate");
    for (const marker of ["[[Another", ":::custom", "Term", "% vendor"]) {
      expect(map.blocks.find((b) => b.source.includes(marker))?.capability).toBe("protected");
    }
    expect(map.segments.map((s) => s.source).join("")).toBe(text);
  });

  it("measures offsets in UTF-16, including emoji before CRLF and table cells", () => {
    const text = "🎉\r\n\r\n# Heading\r\n\r\n| a | b |\r\n|---|---|\r\n| 中 | é |";
    const map = createSourceMap(snapshot(text));
    const heading = map.blocks[1]!;
    expect(heading.range.from).toBe(text.indexOf("#"));
    expect(heading.range.from).toBe(6);
    expect(new ByteIndex(text).byteOffset(heading.range.from)).toBe(8);
    const table = map.blocks[2]!;
    expect(table.node.type).toBe("table");
    const cell = table.node.children[1]!.children[0]!;
    // GFM cell positions include table punctuation; only the text leaf
    // names the cell content. Do not trim node ranges into edit ranges.
    expect(cell.source.startsWith("| 中")).toBe(true);
    expect(leaves(cell).map((leaf) => leaf.source)).toEqual(["中"]);
    expect(text.slice(cell.range.from, cell.range.to)).toBe(cell.source);
  });

  it("distinguishes raw spelling from decoded text without rewriting it", () => {
    const text = "Plain **bold** &amp; \\*literal\\* [link](url).";
    const node = createSourceMap(snapshot(text)).blocks[0]!.node;
    const texts = leaves(node);
    expect(texts.find((leaf) => leaf.source === "bold")?.exactText).toBe(true);
    expect(texts.some((leaf) => leaf.source.includes("&amp;") && !leaf.exactText)).toBe(true);
    expect(texts.every((leaf) => text.slice(leaf.range.from, leaf.range.to) === leaf.source)).toBe(true);
    expect(createSourceMap(snapshot("plain <sup>tag</sup>")).blocks[0]!.capability).toBe("protected");
  });

  it.each(["", " \r\n\t\r", "# Title", "Text\r\n\r\n", "Text\r\rNext"])("covers all source and trivia: %j", (text) => {
    const map = createSourceMap(snapshot(text));
    let cursor = 0;
    for (const segment of map.segments) {
      expect(segment.range.from).toBe(cursor);
      expect(segment.source).toBe(text.slice(segment.range.from, segment.range.to));
      cursor = segment.range.to;
    }
    expect(cursor).toBe(text.length);
    expect(map.segments.map((segment) => segment.source).join("")).toBe(text);
  });

  it("does not identify repeated blocks by their text or reuse ranges after an edit", () => {
    const base = snapshot("Same.\n\nSame.", 7);
    const map = createSourceMap(base);
    expect(map.blocks[0]!.range.docId).toBe("doc");
    expect(map.blocks[0]!.range.revision).toBe(7);
    expect(map.blocks[0]!.source).toBe(map.blocks[1]!.source);
    expect(map.blocks[0]!.range.from).not.toBe(map.blocks[1]!.range.from);
    for (const current of [snapshot(base.text, 8), snapshot(base.text, 7, "other"), snapshot("New.\n" + base.text, 7)]) {
      expect(() => assertCurrentSourceMap(map, current)).toThrow("stale source map");
    }
    const next = snapshot("Prefix.\n\n" + base.text, 8);
    const rebuilt = createSourceMap(next);
    expect(rebuilt.blocks[1]!.range.from).toBe(9);
    expect(() => assertCurrentSourceMap(rebuilt, next)).not.toThrow();
    expect(Object.isFrozen(map.blocks[0]!.node.children)).toBe(true);
  });

  it("separates safe navigation fallback from editable ranges", () => {
    const base = snapshot("🎉 text\n\n# Next", 3);
    const map = createSourceMap(base);
    expect(navigationAnchor(map, base, 1)).toEqual({ docId: "doc", revision: 3, offset: 0 });
    expect(navigationAnchor(map, base, 3).offset).toBe(3);
    expect(navigationAnchor(map, base, 999).offset).toBe(base.text.indexOf("#"));
    expect(() => navigationAnchor(map, snapshot(base.text, 4), 0)).toThrow("stale");
    expect(() => navigationAnchor(map, base, NaN)).toThrow("invalid");
  });

  it.each(["\ud800", "a\udc00", "\ud800x"])("rejects unpaired surrogates rather than changing bytes: %j", (text) => {
    expect(() => createSourceMap(snapshot(text))).toThrow("unpaired");
  });

  it("enforces optional mapping limits without returning a partial map", () => {
    const base = snapshot("first\n\nsecond");
    expect(() => createSourceMap(base, { maxDepth: 32, maxNodes: 1 })).toThrow("budget");
    expect(() => createSourceMap(snapshot("> ".repeat(40) + "deep"), { maxDepth: 32, maxNodes: 5000 })).toThrow("budget");
    expect(() => createSourceMap(base, { maxDepth: 0, maxNodes: 1 })).toThrow("invalid");
    expect(createSourceMap(base).segments.map((segment) => segment.source).join("")).toBe(base.text);
  });

  it("rejects invalid document identity/revisions", () => {
    for (const base of [snapshot("x", -1), snapshot("x", 1.5), snapshot("x", 0, "")]) {
      expect(() => createSourceMap(base)).toThrow("identity");
    }
  });
});
