import { convertFileSrc } from "@tauri-apps/api/core";
import { resolveMediaPath, portableMediaUri } from "./media-path";
/**
 * The unified/remark/rehype render pipeline (ADR-003).
 *
 * One pipeline serves three consumers:
 *  - the Node-side golden tests (string in → HTML string out, no DOM),
 *  - the React reader (react-markdown reuses the same remark/rehype plugins),
 *  - exports (M5) which reuse the same plugins and URL policy.
 *
 * Security defaults (T1/T4, FR-022):
 *  - raw HTML is never executed: it is converted to visibly-marked escaped
 *    code blocks BEFORE mdast→hast, so no raw node can reach a DOM layer;
 *  - math (M2: source fallback) is converted to marked code the same way;
 *  - the URL policy (url-policy.ts) is applied at the DOM layer by the
 *    reader and is separately unit-tested; the pipeline keeps URLs intact
 *    so golden output is a faithful record of what the policy must handle.
 */
import rehypeStringify from "rehype-stringify";
import remarkRehype from "remark-rehype";

import { createMarkdownParser, markdownSyntaxPlugins } from "./parser";

import { extractOutline, type OutlineItem } from "./outline";
import { classifyUrl, safeUrl } from "./url-policy";

// The mdast/hast types are structural; we keep a minimal local shape to stay
// independent of the exact mdast version pinned transitively.
export interface MNode {
  type: string;
  value?: string;
  lang?: string;
  depth?: number;
  children?: MNode[];
  position?: { start?: { line?: number } };
  data?: { hProperties?: Record<string, unknown> };
}
export interface VFileLike {
  data: Record<string, unknown>;
}
export type Transformer = (tree: MNode, file: VFileLike) => void;
export type Plugin = () => Transformer;

export interface FrontmatterMeta {
  /** The exact raw text between the fences (never mutated). */
  raw: string;
  /** Top-level `key: value` pairs, for the compact preview card. */
  pairs: { key: string; value: string }[];
}

export interface RenderResult {
  /** Rendered HTML (raw HTML escaped, no scripts possible). */
  html: string;
  /** Heading outline in document order (ids match the `id` attributes). */
  outline: OutlineItem[];
  /** Frontmatter, if the document starts with a YAML fence. */
  frontmatter: FrontmatterMeta | null;
}

// ---------------------------------------------------------------------------
// Frontmatter (FR-026): recognized, raw text preserved, compact display.
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/** String-level frontmatter detection (used for the preview card). */
export function parseFrontmatter(markdown: string): FrontmatterMeta | null {
  const m = FRONTMATTER_RE.exec(markdown);
  const raw = m?.[1];
  if (!m || raw === undefined) return null;
  const pairs: FrontmatterMeta["pairs"] = [];
  for (const line of raw.split(/\r?\n/)) {
    const p = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (p && p[1] !== undefined && p[2] !== undefined) {
      pairs.push({ key: p[1], value: p[2].trim() });
    }
  }
  return { raw, pairs };
}

/** Strip the frontmatter node from the tree; content starts after it. */
export const stripFrontmatter: Plugin = () => (tree: MNode) => {
  const first = tree.children?.[0];
  if (first && first.type === "yaml" && tree.children) {
    tree.children = tree.children.slice(1);
  }
};

// ---------------------------------------------------------------------------
// Raw HTML → escaped, marked code (T1, ADR-003: escape-by-default).
// ---------------------------------------------------------------------------

export const rawHtmlToCode: Plugin = () => (tree: MNode) => {
  const swap = (children: MNode[]) => {
    for (let i = 0; i < children.length; i++) {
      const n = children[i];
      if (!n) continue;
      if (n.type === "html") {
        const value = n.value ?? "";
        children[i] = value.includes("\n")
          ? {
              type: "code",
              lang: "html",
              value,
              position: n.position,
              data: { hProperties: { "data-render": "raw-html" } },
            }
          : {
              type: "inlineCode",
              value,
              position: n.position,
              data: { hProperties: { "data-render": "raw-html-inline" } },
            };
      } else if (n.children) {
        swap(n.children);
      }
    }
  };
  if (tree.children) swap(tree.children);
};

// ---------------------------------------------------------------------------
// Math → marked source (M2 fallback; M4 swaps the component internals to
// KaTeX without touching this plugin).
// ---------------------------------------------------------------------------

export const mathToSource: Plugin = () => (tree: MNode) => {
  const swap = (children: MNode[]) => {
    for (let i = 0; i < children.length; i++) {
      const n = children[i];
      if (!n) continue;
      if (n.type === "math") {
        children[i] = {
          type: "code",
          lang: "tex",
          value: n.value ?? "",
          position: n.position,
          data: { hProperties: { "data-render": "math-block" } },
        };
      } else if (n.type === "inlineMath") {
        children[i] = {
          type: "inlineCode",
          value: n.value ?? "",
          position: n.position,
          data: { hProperties: { "data-render": "math-inline" } },
        };
      } else if (n.children) {
        swap(n.children);
      }
    }
  };
  if (tree.children) swap(tree.children);
};

// ---------------------------------------------------------------------------
// Heading ids + outline (FR-014). Slugs are computed ONCE on the MDAST and
// assigned to the i-th heading element in document order, so the DOM ids and
// the outline list cannot diverge.
// ---------------------------------------------------------------------------

export const collectOutline: Plugin = () => (tree: MNode, file: VFileLike) => {
  const outline = extractOutline(tree);
  file.data.outline = outline;
  file.data.slugs = outline.map((o) => o.slug);
};

interface HastElementLike {
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: unknown[];
}

function walkHast(node: unknown, fn: (el: HastElementLike) => void): void {
  const n = node as HastElementLike;
  if (!n || typeof n !== "object") return;
  // The hast root has no tagName — still descend into its children.
  if (typeof n.tagName === "string") fn(n);
  for (const c of n.children ?? []) walkHast(c, fn);
}

export const assignHeadingIds: Plugin = () => (tree: MNode, file: VFileLike) => {
  const slugs = (file.data.slugs as string[] | undefined) ?? [];
  let i = 0;
  walkHast(tree, (el) => {
    if (/^h[1-6]$/.test(el.tagName ?? "")) {
      el.properties = el.properties ?? {};
      el.properties.id = slugs[i] ?? `heading-${i + 1}`;
      i += 1;
    }
  });
};

// ---------------------------------------------------------------------------
// URL policy at the hast level (T1/T4, FR-022/023). Enforced ONCE here so
// the React reader, the Node golden tests, and M5 exports all inherit it.
//
//  - links: `href` is policy-validated; blocked URLs have their href
//    removed (text stays visible, link renders inert);
//  - images: relative refs resolve against the CONTAINING DOCUMENT into a
//    `local-media:` URI (the Rust protocol scope-checks each request);
//    remote/blocked images become an inert placeholder (no network, T4).
// ---------------------------------------------------------------------------

/** Resolve platform path spelling, then use Tauri's platform-specific protocol URL. */
export function imageSrc(original: string, docPath: string | null): string | null {
  const kind = classifyUrl(original);
  if (kind === "localMedia") return original;
  if (kind !== "relative" || !docPath) return null;
  const path = resolveMediaPath(original, docPath);
  if (!path) return null;
  const internals = typeof window !== "undefined" ? (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: unknown } }).__TAURI_INTERNALS__ : undefined;
  return portableMediaUri(path, typeof internals?.convertFileSrc === "function" ? convertFileSrc : undefined);
}

function imageReason(original: string): string {
  try { decodeURIComponent(original); } catch { return "Image path has invalid URI encoding"; }
  const kind = classifyUrl(original);
  if (kind === "remote") return "Remote image — disabled (privacy)";
  if (kind === "blocked") return "Image blocked by URL policy";
  return "Image not available (unsaved document)";
}

export function urlPolicyPlugin(docPath: string | null): Plugin {
  return () => (tree: MNode) => {
    const transform = (children: MNode[]) => {
      for (let i = 0; i < children.length; i++) {
        const n = children[i];
        if (!n || n.type !== "element") continue;
        const tagName = (n as { tagName?: string }).tagName ?? "";
        const props = ((n as { properties?: Record<string, unknown> }).properties ??= {});
        if (tagName === "img") {
          const original = String(props.src ?? "");
          const src = imageSrc(original, docPath);
          if (src !== null) {
            props.src = src;
            props.loading = "lazy";
          } else {
            // Inert placeholder: demote to a <span> so no <img> carries a
            // forbidden src (T4 — the element must not fetch).
            (n as { tagName?: string }).tagName = "span";
            delete props.src;
            const why = imageReason(original);
            (n as { children?: MNode[] }).children = [{ type: "text", value: why }];
            props["data-render"] = "img-unavailable";
            props.role = "img";
            props["aria-label"] = why;
          }
        } else if (tagName === "a") {
          const original = String(props.href ?? "");
          const safe = safeUrl(original, "link");
          if (safe === "") delete props.href;
          else props.href = safe;
        }
        if (Array.isArray((n as { children?: unknown[] }).children)) {
          transform((n as { children: MNode[] }).children);
        }
      }
    };
    if (tree.children) transform(tree.children);
  };
}

// ---------------------------------------------------------------------------
// The pipeline itself.
// ---------------------------------------------------------------------------

export function createProcessor(docPath: string | null = null) {
  return createMarkdownParser()
    .use(stripFrontmatter as never)
    .use(rawHtmlToCode as never)
    .use(mathToSource as never)
    .use(collectOutline as never)
    .use(remarkRehype as never, { allowDangerousHTML: false })
    .use(assignHeadingIds as never)
    .use(urlPolicyPlugin(docPath) as never)
    .use(rehypeStringify as never);
}

/** String in → { html, outline, frontmatter }. */
export function renderMarkdown(markdown: string, docPath: string | null = null): RenderResult {
  const file = createProcessor(docPath).processSync(markdown);
  return {
    html: String(file.value),
    outline: (file.data.outline as OutlineItem[] | undefined) ?? [],
    frontmatter: parseFrontmatter(markdown),
  };
}

/** Outline of a markdown string (same slugs the DOM ids receive). */
export function outlineOf(markdown: string): OutlineItem[] {
  const mdast = createMdast(markdown);
  return extractOutline(mdast);
}

/** Parse to MDAST only (no hast) — for outline and future source maps. */
export function createMdast(markdown: string): MNode {
  return createMarkdownParser().parse(markdown) as unknown as MNode;
}

/**
 * The exact plugin lists the React reader uses, so DOM rendering and the
 * Node pipeline cannot drift (ADR-003: one pipeline, three consumers).
 */
export const readerRemarkPlugins = [
  ...markdownSyntaxPlugins,
  stripFrontmatter,
  rawHtmlToCode,
  mathToSource,
  collectOutline,
] as const;

export function readerRehypePlugins(docPath: string | null) {
  return [assignHeadingIds, urlPolicyPlugin(docPath)] as const;
}
