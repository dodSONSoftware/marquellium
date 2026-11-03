import { createMdast, type MNode } from "../../core/render/pipeline";
import { safeUrl } from "../../core/render/url-policy";
import { renderMath } from "../../core/render/math";

interface Node extends MNode { url?: string; alt?: string; identifier?: string; checked?: boolean | null; ordered?: boolean; start?: number; position?: { start?: { line?: number; offset?: number }; end?: { offset?: number } } }
export interface ExportRun { text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; href?: string }
export type ExportBlock = { kind: "paragraph"; runs: ExportRun[]; heading?: number; quote?: boolean } | { kind: "table"; rows: ExportRun[][][] } | { kind: "image"; href: string; alt: string };
export interface ExportDocument { body: string; blocks: ExportBlock[]; warnings: string[] }
export interface ExportResources { image: (href: string) => Promise<string>; mermaid: (source: string) => Promise<string> }
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const exportCss = `body{font:16px/1.55 system-ui;color:#161616;background:white;margin:2em auto;max-width:900px;padding:0 1em}img,svg{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #888;padding:.4em}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f4f4;padding:1em}blockquote{border-left:3px solid #999;padding-left:1em}a{color:#1455a0}math{font-size:1.15em}.export-note{font-size:.85em;color:#555}@page{size:auto;margin:18mm}@media print{body{margin:0;max-width:none}h1,h2,h3,h4,h5,h6{break-after:avoid;page-break-after:avoid}li>p{margin:.2em 0}.export-heading-group{break-inside:avoid;page-break-inside:avoid}img,tr,pre{break-inside:avoid}.print-controls{display:none!important}}`;
export function standaloneHtml(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)}</title><style>${exportCss}</style></head><body>${body}</body></html>`;
}
/** Same dialect parser as Read/Visual. Unknowns remain visible source; never execute raw HTML. */
export async function exportDocument(markdown: string, resources: ExportResources): Promise<ExportDocument> {
  if (markdown.length > 2 * 1024 * 1024) throw new Error("Export limit is 2 MiB of Markdown");
  const root = createMdast(markdown) as Node;
  const blocks: ExportBlock[] = [], warnings = new Set<string>();
  const definitions = new Map<string, string>();
  const collect = (n: Node, depth = 0) => { if (depth > 32) throw new Error("Export nesting exceeds 32 levels"); if (n.type === "definition") definitions.set(n.identifier ?? "", n.url ?? ""); for (const c of n.children ?? []) collect(c as Node, depth + 1); };
  collect(root);
  const raw = (n: Node) => markdown.slice(n.position?.start?.offset ?? 0, n.position?.end?.offset ?? 0) || n.value || "";
  const runs = (n: Node, style: Omit<ExportRun, "text"> = {}): ExportRun[] => {
    const next = { ...style, ...(n.type === "strong" ? { bold: true } : {}), ...(n.type === "emphasis" ? { italic: true } : {}), ...(n.type === "delete" ? { strike: true } : {}), ...(n.type === "inlineCode" || n.type === "inlineMath" ? { code: true } : {}) };
    if (n.type === "link" || n.type === "linkReference") { const href = safeUrl(n.url ?? definitions.get(n.identifier ?? "") ?? "", "link"); if (href) next.href = href; }
    if (n.type === "image" || n.type === "imageReference") return [{ text: `[Image: ${n.alt ?? ""}]`, ...next }];
    if (n.type === "break") return [{ text: "\n", ...next }];
    if (n.children) return n.children.flatMap((c) => runs(c as Node, next));
    return [{ text: n.value ?? raw(n), ...next }];
  };
  const source = (n: Node, note: string) => { warnings.add(note); blocks.push({ kind: "paragraph", runs: [{ text: `${note}\n${raw(n)}`, code: true }] }); return `<p class="export-note">${escapeHtml(note)}</p><pre>${escapeHtml(raw(n))}</pre>`; };
  const inline = async (n: Node): Promise<string> => {
    if (n.type === "inlineMath") { try { return renderMath(n.value ?? "", false, true); } catch { return `<code>${escapeHtml(n.value ?? "")}</code>`; } }
    if (n.type === "image" || n.type === "imageReference") {
      const href = n.url ?? definitions.get(n.identifier ?? "") ?? "";
      try { const uri = await resources.image(href); if (!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(uri)) throw new Error("Unsupported image resource"); return `<img src="${uri}" alt="${escapeHtml(n.alt ?? "")}">`; }
      catch { const note = `Image unavailable: ${n.alt ?? href} (${href})`; warnings.add(note); return `<span>${escapeHtml(note)}</span>`; }
    }
    const children = n.children ? (await Promise.all(n.children.map((c) => inline(c as Node)))).join("") : escapeHtml(n.value ?? raw(n));
    const tags: Record<string, string> = { strong: "strong", emphasis: "em", delete: "del", inlineCode: "code" };
    if (tags[n.type]) return `<${tags[n.type]}>${children}</${tags[n.type]}>`;
    if (n.type === "break") return "<br>";
    if (n.type === "link" || n.type === "linkReference") { const href = safeUrl(n.url ?? definitions.get(n.identifier ?? "") ?? "", "link"); return href ? `<a href="${escapeHtml(href)}">${children}</a>` : children; }
    return children;
  };
  const images = (n: Node) => { if (n.type === "image" || n.type === "imageReference") blocks.push({ kind: "image", href: n.url ?? definitions.get(n.identifier ?? "") ?? "", alt: n.alt ?? "" }); for (const c of n.children ?? []) images(c as Node); };
  const render = async (n: Node, quote = false, prefix = ""): Promise<string> => {
    if (n.type === "definition") return "";
    if (n.type === "root" || n.type === "blockquote") { const chunks = []; for (const c of n.children ?? []) chunks.push(await render(c as Node, quote || n.type === "blockquote")); const html = chunks.join("\n"); return n.type === "blockquote" ? `<blockquote>${html}</blockquote>` : html; }
    if (n.type === "list") { const tag = n.ordered ? "ol" : "ul"; let i = n.start ?? 1; const rows = []; for (const c of n.children ?? []) rows.push(await render(c as Node, quote, n.ordered ? `${i++}. ` : "• ")); return `<${tag}${n.ordered ? ` start="${n.start ?? 1}"` : ""}>${rows.join("")}</${tag}>`; }
    if (n.type === "listItem") { const task = n.checked == null ? "" : n.checked ? "☑ " : "☐ "; const html = []; let first = true; for (const c of n.children ?? []) { html.push(await render(c as Node, quote, first ? prefix + task : "")); first = false; } return `<li>${html.join("")}</li>`; }
    if (n.type === "paragraph" || n.type === "heading") { blocks.push({ kind: "paragraph", runs: [...(prefix ? [{ text: prefix }] : []), ...runs(n)], ...(n.type === "heading" ? { heading: n.depth } : {}), quote }); images(n); const tag = n.type === "heading" ? `h${n.depth}` : "p"; return `<${tag}>${prefix.match(/[☑☐] /)?.[0] ?? ""}${await inline(n)}</${tag}>`; }
    if (n.type === "table") { const rows = n.children ?? []; blocks.push({ kind: "table", rows: rows.map((r) => (r.children ?? []).map((c) => runs(c as Node))) }); images(n); const html = []; for (const [i, row] of rows.entries()) { const tag = i ? "td" : "th"; html.push(`<tr>${(await Promise.all((row.children ?? []).map(async (c) => `<${tag}>${await inline(c as Node)}</${tag}>`))).join("")}</tr>`); } return `<table>${html.join("")}</table>`; }
    if (n.type === "math") { blocks.push({ kind: "paragraph", runs: [{ text: `Math (TeX source; DOCX fallback):\n${n.value}`, code: true }] }); try { return renderMath(n.value ?? "", true, true); } catch { return source(n, "Invalid math retained as source"); } }
    if (n.type === "code" && n.lang === "mermaid") { blocks.push({ kind: "paragraph", runs: [{ text: `Mermaid diagram (source; DOCX fallback):\n${n.value}`, code: true }] }); try { const svg = await resources.mermaid(n.value ?? ""); return `<img alt="Mermaid diagram" src="data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}">`; } catch { return source(n, "Mermaid preview unavailable; source retained"); } }
    if (n.type === "code") { blocks.push({ kind: "paragraph", runs: [{ text: n.value ?? "", code: true }] }); return `<pre><code>${escapeHtml(n.value ?? "")}</code></pre>`; }
    if (n.type === "thematicBreak") { blocks.push({ kind: "paragraph", runs: [{ text: "────────" }] }); return "<hr>"; }
    return source(n, "Protected source retained");
  };
  // Sequential block traversal preserves DOCX order while async previews resolve.
  let body = "";
  const children = root.children ?? [];
  for (let index = 0; index < children.length; index++) {
    const node = children[index] as Node;
    if (node.type === "heading" && children[index + 1] && children[index + 1]!.type !== "heading") {
      body += `<div class="export-heading-group">${await render(node)}${await render(children[++index] as Node)}</div>\n`;
    } else body += await render(node) + "\n";
  }
  return { body, blocks, warnings: [...warnings] };
}
