/** Bounded literal-text adapter. It never serializes an enclosing Markdown block. */
import { createSourceMap, type DocumentSourceMap, type MappedNode } from "../../core/source-map";
import { prepareLocalizedEdit, type LocalizedEdit } from "../../core/localized-edit";
import { ByteIndex, splitsPair } from "../../core/positions";
import { diffRange } from "../../core/text-diff";
import { applyOps, bytesToString, stringToBytes } from "../../core/ops";

const punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/;
function decode(raw: string): { text: string; offsets: number[] } {
  let text = "";
  const offsets = [0];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\r") { if (raw[i + 1] === "\n") i++; text += "\n"; offsets.push(i + 1); continue; }
    if (raw[i] === "\\" && raw[i + 1] && punctuation.test(raw[i + 1]!)) i++;
    text += raw[i];
    offsets.push(i + 1);
  }
  return { text, offsets };
}
function pathTo(node: MappedNode, target: MappedNode): number[] | null {
  if (node === target) return [];
  for (let i = 0; i < node.children.length; i++) {
    const path = pathTo(node.children[i]!, target);
    if (path) return [i, ...path];
  }
  return null;
}
function shape(node: MappedNode): string { return `${node.type}(${node.children.map(shape).join(",")})`; }
function atPath(node: MappedNode, path: number[]): MappedNode | undefined {
  let current: MappedNode | undefined = node;
  for (const index of path) current = current?.children[index];
  return current;
}
function textPart(leaf: MappedNode): { raw: string; start: number; end: number } {
  if (leaf.type !== "tableCell") return { raw: leaf.source, start: 0, end: leaf.source.length };
  const child = leaf.children[0];
  if (child) return { raw: child.source, start: child.range.from - leaf.range.from, end: child.range.to - leaf.range.from };
  const start = /^\|?[ \t]*/.exec(leaf.source)?.[0].length ?? 0;
  return { raw: "", start, end: start };
}
export function displayedText(leaf: MappedNode): string {
  const text = leaf.type === "tableCell" ? leaf.children[0]?.decodedText ?? "" : leaf.decodedText ?? leaf.source;
  return text.replace(/\r\n|\r/g, "\n");
}
export function displaySourceOffset(leaf: MappedNode, position: number): number { const part = textPart(leaf); return part.start + (decode(part.raw).offsets[position] ?? part.raw.length); }
export function sourceDisplayOffset(leaf: MappedNode, raw: number): number { const part = textPart(leaf); const offsets = decode(part.raw).offsets; const index = offsets.findIndex((offset) => offset >= raw - part.start); return index < 0 ? offsets.length - 1 : index; }
export function editableText(leaf: MappedNode): boolean {
  if (leaf.type === "tableCell") return leaf.children.length === 0 || leaf.children.length === 1 && editableText(leaf.children[0]!);
  return leaf.type === "text" && !!leaf.decodedText && decode(leaf.source).text === displayedText(leaf);
}
function shapeExcept(node: MappedNode, path: number[]): string {
  if (!path.length) return node.type;
  return `${node.type}(${node.children.map((child, i) => i === path[0] ? shapeExcept(child, path.slice(1)) : shape(child)).join(",")})`;
}

export function directTextEdit(map: DocumentSourceMap, leaf: MappedNode, display: string) {
  const blockIndex = map.blocks.findIndex((block) => pathTo(block.node, leaf) !== null);
  const block = map.blocks[blockIndex];
  if (!block || !editableText(leaf) || !["text-candidate", "table-candidate"].includes(block.capability)) throw new Error("use the explicit source editor for this text");
  if ((!display && leaf.type !== "tableCell") || /\r/.test(display) || display.length > 16_384) throw new Error("direct text must be nonempty and at most 16384 characters; use source editing");
  const part = textPart(leaf);
  const original = decode(part.raw);
  const change = diffRange(original.text, display);
  let from = change.from, to = change.to, insertedEnd = change.from + change.insert.length;
  if (splitsPair(original.text, from) || splitsPair(display, from)) from--;
  if (splitsPair(original.text, to) || splitsPair(display, insertedEnd)) { to++; insertedEnd++; }
  const encoded = display.slice(from, insertedEnd).replace(/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/g, "\\$&").replace(/\n/g, leaf.source.match(/\r\n|\r|\n/)?.[0] ?? "\n");
  const replacement = leaf.source.slice(0, part.start) + part.raw.slice(0, original.offsets[from]) + encoded + part.raw.slice(original.offsets[to]) + leaf.source.slice(part.end);
  const request: LocalizedEdit = { docId: map.snapshot.docId, baseRevision: map.snapshot.revision,
    authorizedRange: leaf.range, range: leaf.range, openingText: leaf.source, replacementText: replacement };
  const ops = prepareLocalizedEdit(map.snapshot, request);
  const applied = applyOps(stringToBytes(map.snapshot.text), ops);
  if (!applied.ok) throw new Error(applied.error);
  const expected = bytesToString(applied.next);
  const next = createSourceMap({ ...map.snapshot, revision: map.snapshot.revision + (ops.length ? 1 : 0), text: expected });
  const nextBlock = next.blocks[blockIndex];
  const path = pathTo(block.node, leaf)!;
  const nextLeaf = nextBlock && atPath(nextBlock.node, path);
  const shapesMatch = map.blocks.every((b, i) => i === blockIndex && leaf.type === "tableCell" ? !!next.blocks[i] && shapeExcept(b.node, path) === shapeExcept(next.blocks[i]!.node, path) : !!next.blocks[i] && shape(b.node) === shape(next.blocks[i]!.node));
  if (!nextLeaf || !editableText(nextLeaf) || displayedText(nextLeaf) !== display || nextLeaf.source !== replacement ||
      map.blocks.length !== next.blocks.length || !shapesMatch) {
    throw new Error("edit changes Markdown structure; use the explicit source editor");
  }
  // Check the byte conversion independently of a renderer/serializer.
  if (new ByteIndex(expected).byteOffset(nextLeaf.range.from) === null) throw new Error("unsafe resulting source range");
  return { request, next, nextLeaf, expected };
}
