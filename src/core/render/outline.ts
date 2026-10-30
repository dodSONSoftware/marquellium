/**
 * Document outline (FR-014): hierarchical H1–H6 navigation with
 * GitHub-compatible slugs, including Unicode and duplicate headings.
 *
 * The slugger is the single source of truth for heading ids: the reader's
 * rehype plugin (DOM ids) and the outline list must agree, or anchor
 * navigation and scroll sync break. Pure and deterministic (order-based
 * de-duplication), so it is trivially testable and stable across renders.
 */

export interface OutlineItem {
  /** 1-based heading rank. */
  depth: number;
  /** Raw heading text (inline markup stripped). */
  text: string;
  /** The DOM id this heading receives. */
  slug: string;
  /** 1-based line number in the source (MDAST position). */
  line: number;
}

/**
 * GitHub-flavored slug: lowercase, strip markup punctuation (keeping word
 * characters incl. Unicode letters/digits and spaces→hyphens), trim, then
 * collapse hyphens. Duplicates get `-1`, `-2`, … suffixes in document order
 * (GitHub's algorithm).
 */
export function slugify(heading: string, seen: Map<string, number>): string {
  const base = heading
    .toLowerCase()
    // Keep Unicode letters/digits; drop everything else except spaces.
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
  const key = base || "section";
  const n = seen.get(key) ?? 0;
  seen.set(key, n + 1);
  return n === 0 ? key : `${key}-${n}`;
}

/**
 * Extract outline items from a MDAST (or any tree with the same shape).
 * Only real headings (depth 1–6) participate; setext and atx alike.
 */
export function extractOutline(node: unknown): OutlineItem[] {
  const items: OutlineItem[] = [];
  const seen = new Map<string, number>();
  walk(node, items, seen);
  return items;
}

function textOf(node: unknown): string {
  // Concatenate inline text. `text` and `inlineCode` carry their content in
  // `value`; links/emphasis recurse; images contribute nothing (alt is not
  // text content — matches GitHub's slug behavior).
  const n = node as { type?: string; value?: string; children?: unknown[] };
  if (!n || typeof n !== "object") return "";
  if (n.type === "text" || n.type === "inlineCode") {
    return typeof n.value === "string" ? n.value : "";
  }
  if (Array.isArray(n.children)) {
    return n.children.map((c) => textOf(c)).join("");
  }
  return "";
}

function walk(node: unknown, items: OutlineItem[], seen: Map<string, number>): void {
  const n = node as {
    type?: string;
    depth?: number;
    position?: { start?: { line?: number } };
    children?: unknown[];
  };
  if (!n || typeof n !== "object") return;
  if (n.type === "heading" && typeof n.depth === "number" && n.depth >= 1 && n.depth <= 6) {
    const text = textOf(n).replace(/\s+/g, " ").trim();
    items.push({
      depth: n.depth,
      text,
      slug: slugify(text, seen),
      line: n.position?.start?.line ?? 0,
    });
    return; // heading children are inline; do not descend
  }
  if (Array.isArray(n.children)) {
    for (const c of n.children) walk(c, items, seen);
  }
}
