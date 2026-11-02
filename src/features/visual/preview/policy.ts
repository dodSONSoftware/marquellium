import { createSourceMap } from "../../../core/source-map";

export const MAX_DRAFT_BYTES = 16_384;

function checkSize(text: string) {
  if (new TextEncoder().encode(text).length > MAX_DRAFT_BYTES || text.split(/\r\n|\r|\n/).length > 256) {
    throw new Error("preview input limit exceeded (16 KiB / 256 lines)");
  }
}

export function validateSourcePreview(text: string): void {
  checkSize(text);
  createSourceMap({ docId: "draft", revision: 0, text }, { maxDepth: 32, maxNodes: 5000 });
}

export function checkMermaidBody(text: string): void {
  checkSize(text);
  if (!/^\s*(?:flowchart\s+(?:TD|TB|BT|LR|RL)\b|graph\s+(?:TD|TB|BT|LR|RL)\b|sequenceDiagram\b|classDiagram\b)/.test(text)) {
    throw new Error("prototype preview supports flowchart, sequence and class diagrams");
  }
  // Never let document text supply configuration, callbacks, CSS, assets or URLs.
  if (/%%\{|^\s*---|\b(?:click|classDef|style|linkStyle)\b|(?:https?|data|file|javascript):|url\s*\(|<|>|@\s*\{/im.test(text.replace(/-->>|->>|-->|<\|--|--\|>|<--|->|<-/g, ""))) {
    throw new Error("diagram configuration, HTML, callbacks, styles and external resources are disabled in the prototype");
  }
}

export function mermaidBody(text: string): string {
  checkSize(text);
  const lines = text.split(/\r\n|\r|\n/);
  const first = lines[0] ?? "";
  const opening = /^ {0,3}(`{3,}|~{3,})mermaid(?:[ \t].*)?$/.exec(first);
  if (!opening) throw new Error("expected a mermaid fenced block");
  const fence = opening[1]!;
  const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`);
  let end = lines.length - 1;
  while (end > 0 && lines[end] === "") end--;
  if (end < 2 || !closing.test(lines[end]!)) throw new Error("Mermaid fence is incomplete");
  if (lines.slice(1, end).some((line) => closing.test(line))) throw new Error("draft escapes its original fenced block");
  const body = lines.slice(1, end).join("\n");
  checkMermaidBody(body);
  return body;
}

export function validateTable(text: string): void {
  checkSize(text);
  const map = createSourceMap({ docId: "draft", revision: 0, text }, { maxDepth: 32, maxNodes: 5000 });
  const block = map.blocks[0];
  if (map.blocks.length !== 1 || block?.node.type !== "table" || map.segments.some((segment) => segment.kind === "gap" && segment.source.trim())) {
    throw new Error("draft must contain exactly one GFM table");
  }
  const rows = block.node.children;
  const columns = rows[0]?.children.length ?? 0;
  if (!columns || columns > 20 || rows.length > 100 || rows.some((row) => row.children.length !== columns)) {
    throw new Error("table rows must have matching cells (maximum 100 rows / 20 columns)");
  }
}
