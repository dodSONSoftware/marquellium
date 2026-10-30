/**
 * Outline stability tests (FR-014, M2 gate: duplicate + Unicode headings).
 * The slugger is the single source of truth for heading ids, so these pin
 * the exact GitHub-compatible algorithm the DOM ids rely on.
 */
import { describe, expect, it } from "vitest";
import { extractOutline, slugify } from "./outline";
import { outlineOf } from "./pipeline";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    const seen = new Map<string, number>();
    expect(slugify("Hello World", seen)).toBe("hello-world");
  });

  it("keeps Unicode letters and digits", () => {
    const seen = new Map<string, number>();
    expect(slugify("Ünïcode 漢字测试", seen)).toBe("ünïcode-漢字测试");
  });

  it("strips markup punctuation", () => {
    const seen = new Map<string, number>();
    expect(slugify("(Section) [3]: notes — 2026?", seen)).toBe("section-3-notes-2026");
  });

  it("deduplicates in document order (GitHub algorithm)", () => {
    const seen = new Map<string, number>();
    expect(slugify("Intro", seen)).toBe("intro");
    expect(slugify("Intro", seen)).toBe("intro-1");
    expect(slugify("intro", seen)).toBe("intro-2");
    expect(slugify("INTRO", seen)).toBe("intro-3");
  });

  it("falls back for empty headings", () => {
    const seen = new Map<string, number>();
    expect(slugify("!!!", seen)).toBe("section");
    expect(slugify("", seen)).toBe("section-1");
  });
});

describe("extractOutline / outlineOf", () => {
  const doc = [
    "# Title",
    "",
    "## Alpha",
    "",
    "Body **with** `code`.",
    "",
    "## Alpha",
    "",
    "### Deep (one)",
    "",
    "## Beta — 漢字",
    "",
    "#### Skipped by TOC? no: depth 4 still listed",
  ].join("\n");

  it("lists headings in order with depth and line", () => {
    const items = outlineOf(doc);
    expect(items.map((i) => [i.depth, i.text, i.slug])).toEqual([
      [1, "Title", "title"],
      [2, "Alpha", "alpha"],
      [2, "Alpha", "alpha-1"],
      [3, "Deep (one)", "deep-one"],
      [2, "Beta — 漢字", "beta-漢字"],
      [4, "Skipped by TOC? no: depth 4 still listed", "skipped-by-toc-no-depth-4-still-listed"],
    ]);
    expect(items[0]?.line).toBe(1);
    expect(items[2]?.line).toBe(7);
  });

  it("inline markup contributes its text to the slug", () => {
    const items = outlineOf("# Heading with **bold** and `code` span");
    expect(items[0]?.slug).toBe("heading-with-bold-and-code-span");
    expect(items[0]?.text).toBe("Heading with bold and code span");
  });

  it("ignores headings inside code blocks", () => {
    const items = outlineOf("```\n# not a heading\n```\n# Real");
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe("Real");
  });

  it("setext headings participate", () => {
    const items = outlineOf("Setext title\n==============\n\nbody");
    expect(items[0]?.slug).toBe("setext-title");
    expect(items[0]?.depth).toBe(1);
  });

  it("works on the raw mdast shape", () => {
    const items = extractOutline({
      type: "root",
      children: [
        {
          type: "heading",
          depth: 2,
          position: { start: { line: 3 } },
          children: [{ type: "text", value: "From the API" }],
        },
      ],
    });
    expect(items).toEqual([
      { depth: 2, text: "From the API", slug: "from-the-api", line: 3 },
    ]);
  });
});
