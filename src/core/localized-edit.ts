/** Validates a captured edit and prepares one minimal, pre-batch byte operation. */
import { ByteIndex, assertWellFormedText } from "./positions";
import type { ByteOp } from "./ops";
import type { DocumentSourceMap, MappedBlock, MappedNode, SourceRange, SourceSnapshot } from "./source-map";

export interface LocalizedEdit {
  readonly docId: string;
  readonly baseRevision: number;
  /** Maximum permitted construct, in the captured document revision. */
  readonly authorizedRange: SourceRange;
  /** Target inside that construct; openingText must match this exact slice. */
  readonly range: SourceRange;
  readonly openingText: string;
  /** Markdown source spelling, not an escaped serialization of displayed text. */
  readonly replacementText: string;
}

/** Copy before asynchronous flushing so callers cannot alter an in-flight request. */
export function captureLocalizedEdit(edit: LocalizedEdit): LocalizedEdit {
  return Object.freeze({
    ...edit,
    authorizedRange: Object.freeze({ ...edit.authorizedRange }),
    range: Object.freeze({ ...edit.range }),
  });
}

function graphemeBoundaryCheck(text: string, segmenter: Intl.Segmenter): (position: number) => boolean {
  const segments = segmenter.segment(text);
  return (position) => position === text.length || segments.containing(position)?.index === position;
}

function checkRange(range: SourceRange, current: SourceSnapshot, isBoundary: (position: number) => boolean): void {
  if (range.docId !== current.docId || range.revision !== current.revision) {
    throw new Error("stale localized edit range");
  }
  if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) ||
      range.from < 0 || range.to < range.from || range.to > current.text.length ||
      !isBoundary(range.from) || !isBoundary(range.to)) {
    throw new Error("unsafe localized edit range");
  }
}

export function prepareLocalizedEdit(current: SourceSnapshot, edit: LocalizedEdit): ByteOp[] {
  if (!current.docId || !Number.isSafeInteger(current.revision) || current.revision < 0 ||
      edit.docId !== current.docId || edit.baseRevision !== current.revision) {
    throw new Error("stale localized edit snapshot");
  }
  assertWellFormedText(current.text);
  assertWellFormedText(edit.replacementText);
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const isBoundary = graphemeBoundaryCheck(current.text, segmenter);
  checkRange(edit.authorizedRange, current, isBoundary);
  checkRange(edit.range, current, isBoundary);
  const { from, to } = edit.range;
  if (from < edit.authorizedRange.from || to > edit.authorizedRange.to) {
    throw new Error("localized edit escapes its authorized construct");
  }
  if (current.text.slice(from, to) !== edit.openingText) {
    throw new Error("localized edit opening text no longer matches");
  }
  if (edit.openingText === edit.replacementText) return [];

  // A code-unit prefix diff can split emoji or combining/ZWJ sequences.
  // Match whole graphemes instead, without expanding beyond the captured range.
  const oldParts = Array.from(segmenter.segment(edit.openingText));
  const newParts = Array.from(segmenter.segment(edit.replacementText));
  let prefix = 0;
  while (prefix < oldParts.length && prefix < newParts.length &&
      oldParts[prefix]!.segment === newParts[prefix]!.segment) prefix++;
  let suffix = 0;
  while (suffix < oldParts.length - prefix && suffix < newParts.length - prefix &&
      oldParts[oldParts.length - 1 - suffix]!.segment === newParts[newParts.length - 1 - suffix]!.segment) suffix++;
  const start = oldParts[prefix]?.index ?? edit.openingText.length;
  const oldEnd = oldParts[oldParts.length - suffix]?.index ?? edit.openingText.length;
  const newStart = newParts[prefix]?.index ?? edit.replacementText.length;
  const newEnd = newParts[newParts.length - suffix]?.index ?? edit.replacementText.length;
  const inserted = edit.replacementText.slice(newStart, newEnd);

  const next = current.text.slice(0, from) + edit.replacementText + current.text.slice(to);
  const nextBoundary = graphemeBoundaryCheck(next, segmenter);
  if (!nextBoundary(from) || !nextBoundary(from + edit.replacementText.length)) {
    throw new Error("replacement joins a grapheme outside the authorized range");
  }
  const index = new ByteIndex(current.text);
  const startByte = index.byteOffset(from + start);
  const endByte = index.byteOffset(from + oldEnd);
  if (startByte === null || endByte === null) throw new Error("unsafe localized byte boundary");
  return [{ startByte, endByte, text: inserted }];
}

function containsNode(parent: MappedNode, target: MappedNode): boolean {
  return parent === target || parent.children.some((child) => containsNode(child, target));
}

/** Raw source spelling for an exact leaf; later adapters own semantic validation.
 * The range cannot consume adjacent emphasis, link, or table delimiters. */
export function editMappedText(map: DocumentSourceMap, leaf: MappedNode, replacementText: string): LocalizedEdit {
  const block = map.blocks.find((candidate) => containsNode(candidate.node, leaf));
  if (!block || leaf.type !== "text" || !leaf.exactText ||
      (block.capability !== "text-candidate" && block.capability !== "table-candidate")) {
    throw new Error("text leaf is protected, ambiguous, or belongs to another map");
  }
  return captureLocalizedEdit({ docId: map.snapshot.docId, baseRevision: map.snapshot.revision,
    authorizedRange: leaf.range, range: leaf.range, openingText: leaf.source, replacementText });
}

/** Explicit construct source replacement, for later validated structural/draft adapters. */
export function editMappedBlock(map: DocumentSourceMap, block: MappedBlock, replacementText: string): LocalizedEdit {
  if (!map.blocks.includes(block)) throw new Error("block belongs to another source map");
  return captureLocalizedEdit({ docId: map.snapshot.docId, baseRevision: map.snapshot.revision,
    authorizedRange: block.range, range: block.range, openingText: block.source, replacementText });
}
