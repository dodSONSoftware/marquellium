/** Revision-bound source coordinates. This module never serializes or edits Markdown. */
import { createMarkdownParser } from "./render/parser";
import { assertWellFormedText, splitsPair } from "./positions";

// These coordinates cannot be passed as byte offsets without an explicit conversion.
declare const utf16: unique symbol;
export type Utf16Offset = number & { readonly [utf16]: true };

export interface SourceSnapshot {
  readonly docId: string;
  readonly revision: number;
  /** Canonical text, with the file's BOM already handled by the document service. */
  readonly text: string;
}

export interface SourceRange {
  readonly docId: string;
  readonly revision: number;
  readonly from: Utf16Offset;
  readonly to: Utf16Offset;
}

export interface MappedNode {
  readonly type: string;
  readonly range: SourceRange;
  readonly source: string;
  /** True only when a text node's raw spelling equals its parsed value. */
  readonly exactText: boolean;
  readonly decodedText?: string;
  readonly depth?: number;
  readonly align?: readonly ("left" | "right" | "center" | null)[];
  readonly children: readonly MappedNode[];
}

export type BlockCapability = "text-candidate" | "table-candidate" | "mermaid-draft" | "protected";
export interface MappedBlock {
  readonly kind: "block";
  readonly range: SourceRange;
  readonly source: string;
  readonly node: MappedNode;
  /** Classification for future adapters; never permission to regenerate a block. */
  readonly capability: BlockCapability;
  readonly reason: string;
}
export interface SourceGap {
  readonly kind: "gap";
  readonly range: SourceRange;
  readonly source: string;
}
export interface DocumentSourceMap {
  readonly snapshot: SourceSnapshot;
  /** Ordered, non-overlapping coverage of the entire canonical source, including trivia. */
  readonly segments: readonly (MappedBlock | SourceGap)[];
  readonly blocks: readonly MappedBlock[];
}

export interface MappingLimits { readonly maxDepth: number; readonly maxNodes: number }
interface MappingBudget { limits: MappingLimits; nodes: number }

interface ParseNode {
  type: string;
  value?: string;
  lang?: string | null;
  depth?: number;
  align?: ("left" | "right" | "center" | null)[] | null;
  children?: ParseNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

function offset(text: string, value: number | undefined): Utf16Offset {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0 ||
      value > text.length || splitsPair(text, value)) {
    throw new Error("invalid UTF-16 source boundary");
  }
  return value as Utf16Offset;
}

function range(snapshot: SourceSnapshot, from: number | undefined, to: number | undefined): SourceRange {
  const start = offset(snapshot.text, from);
  const end = offset(snapshot.text, to);
  if (start > end) throw new Error("inverted source range");
  return Object.freeze({ docId: snapshot.docId, revision: snapshot.revision, from: start, to: end });
}

function mapNode(node: ParseNode, snapshot: SourceSnapshot, parent: SourceRange, budget?: MappingBudget, depth = 0): MappedNode {
  if (budget && (++budget.nodes > budget.limits.maxNodes || depth > budget.limits.maxDepth)) throw new Error("source mapping budget exceeded");
  const text = snapshot.text;
  const ownRange = range(snapshot, node.position?.start.offset, node.position?.end.offset);
  if (ownRange.from < parent.from || ownRange.to > parent.to) {
    throw new Error("source node escapes its parent");
  }
  const source = text.slice(ownRange.from, ownRange.to);
  let cursor = ownRange.from;
  const children = (node.children ?? []).map((child) => {
    const mapped = mapNode(child, snapshot, ownRange, budget, depth + 1);
    if (mapped.range.from < cursor) throw new Error("overlapping source nodes");
    cursor = mapped.range.to;
    return mapped;
  });
  return Object.freeze({
    type: node.type, range: ownRange, source,
    exactText: node.type === "text" && source === node.value,
    decodedText: node.type === "text" ? node.value : undefined,
    depth: node.depth,
    align: node.align ? Object.freeze([...node.align]) : undefined,
    children: Object.freeze(children),
  });
}

const textNodeTypes = new Set(["paragraph", "heading", "text", "emphasis", "strong", "delete", "link", "inlineCode", "break"]);
const tableNodeTypes = new Set([...textNodeTypes, "table", "tableRow", "tableCell"]);

function containsUnknown(node: MappedNode, allowed: ReadonlySet<string>): boolean {
  return !allowed.has(node.type) || node.children.some((child) => containsUnknown(child, allowed));
}

/** Common extension syntax can parse as ordinary text; AST type alone is insufficient. */
function extensionSyntax(source: string): boolean {
  return /\[\[|!\[\[|\[![\w-]+\]|^\s*(?:%|:::+|\.\.\s|:\s|=\s)|\}\s*$|\{[^\n}]*\}/m.test(source);
}

function classify(node: ParseNode, mapped: MappedNode): Pick<MappedBlock, "capability" | "reason"> {
  if (node.type === "code" && node.lang === "mermaid") {
    return { capability: "mermaid-draft", reason: "Mermaid source draft requires validation before Apply" };
  }
  if (extensionSyntax(mapped.source)) {
    return { capability: "protected", reason: "possible unsupported extension syntax" };
  }
  if ((node.type === "paragraph" || node.type === "heading") && !containsUnknown(mapped, textNodeTypes)) {
    return { capability: "text-candidate", reason: "only exact text leaves may be considered by a future edit adapter" };
  }
  if (node.type === "table" && !containsUnknown(mapped, tableNodeTypes)) {
    return { capability: "table-candidate", reason: "cell ranges mapped; table syntax still requires adapter validation" };
  }
  return { capability: "protected", reason: "no prototype adapter for this construct or its children" };
}

export function createSourceMap(snapshot: SourceSnapshot, limits?: MappingLimits): DocumentSourceMap {
  if (limits && (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1 || !Number.isSafeInteger(limits.maxNodes) || limits.maxNodes < 1)) throw new Error("invalid source mapping budget");
  const budget = limits ? { limits: { ...limits }, nodes: 0 } : undefined;
  if (!snapshot.docId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new Error("invalid source snapshot identity");
  }
  // Rust supplies valid UTF-8. Reject synthetic malformed JS input rather than
  // letting later TextEncoder conversion silently replace an isolated surrogate.
  assertWellFormedText(snapshot.text);
  const captured = Object.freeze({ ...snapshot });
  const root: ParseNode = createMarkdownParser().parse(captured.text);
  const whole = range(captured, 0, captured.text.length);
  const segments: (MappedBlock | SourceGap)[] = [];
  const blocks: MappedBlock[] = [];
  let cursor = 0;
  for (const node of root.children ?? []) {
    const mapped = mapNode(node, captured, whole, budget);
    if (mapped.range.from < cursor) throw new Error("overlapping source blocks");
    if (mapped.range.from > cursor) {
      segments.push(Object.freeze({ kind: "gap", range: range(captured, cursor, mapped.range.from), source: captured.text.slice(cursor, mapped.range.from) }));
    }
    const block: MappedBlock = Object.freeze({ kind: "block", range: mapped.range, source: mapped.source, node: mapped, ...classify(node, mapped) });
    blocks.push(block);
    segments.push(block);
    cursor = mapped.range.to;
  }
  if (cursor < captured.text.length) {
    segments.push(Object.freeze({ kind: "gap", range: range(captured, cursor, captured.text.length), source: captured.text.slice(cursor) }));
  }
  return Object.freeze({ snapshot: captured, segments: Object.freeze(segments), blocks: Object.freeze(blocks) });
}

export function assertCurrentSourceMap(map: DocumentSourceMap, current: SourceSnapshot): void {
  const base = map.snapshot;
  if (base.docId !== current.docId || base.revision !== current.revision || base.text !== current.text) {
    throw new Error("stale source map; rebuild from the current canonical snapshot");
  }
}

export interface SourceAnchor {
  readonly docId: string;
  readonly revision: number;
  readonly offset: Utf16Offset;
}

/** Navigation only. Unsafe/missing positions fall back to a block start, never an edit range. */
export function navigationAnchor(map: DocumentSourceMap, current: SourceSnapshot, position: number): SourceAnchor {
  assertCurrentSourceMap(map, current);
  if (!Number.isFinite(position)) throw new Error("invalid navigation position");
  let target: Utf16Offset;
  if (Number.isInteger(position) && position >= 0 && position <= current.text.length && !splitsPair(current.text, position)) {
    target = offset(current.text, position);
  } else {
    const starts = [offset(current.text, 0), ...map.blocks.map((block) => block.range.from)];
    target = starts.reduce((best, start) => Math.abs(start - position) < Math.abs(best - position) ? start : best);
  }
  return Object.freeze({ docId: current.docId, revision: current.revision, offset: target });
}
