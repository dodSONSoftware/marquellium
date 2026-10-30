/**
 * M2 gate — golden renders (docs/test-plan.md).
 *
 * The whole `fixtures/markdown/` corpus must render through the ADR-003
 * pipeline without exception, script-free, with outline ids that match the
 * emitted `id` attributes. Hostile fixtures pin the security behavior:
 *   - xss-script:       raw HTML escaped into marked code blocks (T1),
 *   - javascript-url:   no executable href survives (T1),
 *   - tracking-pixel:   no remote src survives; placeholders instead (T4),
 *   - path-traversal:   every image is a scoped local-media: URI or an
 *                       inert placeholder (T3; the scope check itself is
 *                       enforced and tested in Rust),
 *   - mermaid-bomb, deep-nesting, oversized-embedded: bounded, budgeted
 *     rendering (T2/T8).
 *
 * Opening tags are scanned (not raw substrings) because escaped raw-HTML
 * code blocks legitimately CONTAIN text like `onerror="..."`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderMarkdown } from "../../core/render/pipeline";

const ROOT = join(__dirname, "..", "..", "..");
const FIX = (p: string) => join(ROOT, "fixtures", p);

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out.sort();
}

/** Opening tags only — escaped raw-HTML text cannot match. */
function openingTags(html: string): string[] {
  const tags: string[] = [];
  const re = /<[a-zA-Z][a-zA-Z0-9-]*\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) tags.push(m[0]);
  return tags;
}

/**
 * Decode the entities the stringifier emits for angle brackets/ampersand.
 * Pin the SEMANTIC invariant (raw markup is visible, escaped) without
 * over-pinning the exact entity spelling (`&#x3C;` vs `&lt;`).
 */
function decodeAngleEntities(html: string): string {
  return html
    .replace(/&#x3C;/gi, "<")
    .replace(/&#x3E;/gi, ">")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x26;/gi, "&")
    .replace(/&amp;/g, "&");
}

const CORPUS_FILES = listMarkdownFiles(FIX("markdown"));

describe("corpus golden renders (FR-020, T1)", () => {
  it("covers the expected corpus", () => {
    expect(CORPUS_FILES.length).toBeGreaterThanOrEqual(15);
    for (const name of [
      "gfm-full.md",
      "common-markdown.md",
      "unicode.md",
      "mermaid-math.md",
      "frontmatter.md",
      "unsupported-constructs.md",
      "code-heavy.md",
      "links-images.md",
      "large-1mb.md",
    ]) {
      expect(CORPUS_FILES.some((f) => f.endsWith(name))).toBe(true);
    }
  });

  for (const file of CORPUS_FILES) {
    it(`renders ${file.slice(ROOT.length + 1)}`, () => {
      const md = readFileSync(file, "utf8");
      const { html, outline } = renderMarkdown(md, file);
      expect(html.length).toBeGreaterThan(0);

      // No live scripts, ever (raw HTML is escaped by construction).
      expect(html).not.toMatch(/<script[\s>/]/i);
      for (const tag of openingTags(html)) {
        expect(tag).not.toMatch(/\son[a-zA-Z]+\s*=/i);
      }

      // Outline ids must be present in the emitted HTML (anchor contract).
      for (const item of outline) {
        expect(html, `missing id for heading "${item.text}"`).toContain(
          `id="${item.slug}"`,
        );
      }
    });
  }
});

describe("GFM structure (FR-020)", () => {
  const { html } = renderMarkdown(
    readFileSync(FIX("markdown/gfm-full.md"), "utf8"),
    FIX("markdown/gfm-full.md"),
  );

  it("renders tables", () => {
    expect(html).toMatch(/<table>/);
    expect(html).toMatch(/<th[^>]*>/);
  });

  it("renders task lists as disabled checkboxes", () => {
    const inputTags = openingTags(html).filter((t) => t.startsWith("<input"));
    expect(
      inputTags.some(
        (t) => t.includes('type="checkbox"') && /disabled/.test(t),
      ),
    ).toBe(true);
  });

  it("renders strikethrough", () => {
    expect(html).toMatch(/<del>/);
  });

  it("renders autolinks and keeps plain text plain", () => {
    // GFM 1.0 (matches GitHub + remark-gfm): www. domains autolink to http://
    expect(html).toMatch(/<a href="http:\/\/www\.example\.com">www\.example\.com<\/a>/);
    expect(html).toMatch(/<a href="https:\/\/example\.com\/path\?query=1#frag">/);
    // No scheme and no www: stays plain text.
    expect(html).toContain("example.com (does NOT autolink: no scheme, no www)");
  });

  it("renders footnotes", () => {
    // remark-gfm mirrors GitHub's DOM: footnote ids carry a "user-content-"
    // prefix; ref↔definition hrefs stay consistent either way.
    expect(html).toMatch(/id="(?:user-content-)?fn-1"/);
    expect(html).toMatch(/href="#(?:user-content-)?fn-1"/);
  });

  it("renders fenced code with language class", () => {
    expect(html).toMatch(/class="[^"]*language-[a-z]+/);
  });
});

describe("frontmatter (FR-026)", () => {
  const file = FIX("markdown/frontmatter.md");
  const { html, frontmatter, outline } = renderMarkdown(
    readFileSync(file, "utf8"),
    file,
  );

  it("preserves raw and exposes pairs", () => {
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.raw).toContain("title: Frontmatter Fixture");
    const keys = frontmatter!.pairs.map((p) => p.key);
    expect(keys).toEqual(["title", "author", "date", "tags", "draft", "custom"]);
  });

  it("strips the fence from rendered content", () => {
    expect(html).not.toContain("title: Frontmatter Fixture");
    expect(html).toContain("Frontmatter Handling");
  });

  it("outlines only real content headings", () => {
    expect(outline[0]?.text).toBe("Frontmatter Handling");
  });
});

describe("local resolution (FR-023)", () => {
  const file = FIX("markdown/links-images.md");
  const { html } = renderMarkdown(readFileSync(file, "utf8"), file);

  it("resolves relative images against the containing document", () => {
    const dir = file.slice(0, file.lastIndexOf("/") + 1);
    // Absolute local-media: URI (the Rust handler requires an absolute
    // path and scope-checks it). dir ends in "/", so the join keeps the
    // leading slash: "local-media:/Users/...".
    const expected =
      "local-media:" +
      (dir + "assets/diagram.png").split("/").map(encodeURIComponent).join("/");
    expect(html).toContain(`src="${expected}"`);
  });

  it("keeps relative document links for the app to open", () => {
    expect(html).toMatch(/href="\.\.?\/[^"]*\.md"/);
  });

  it("blocks file: scheme images", () => {
    const { html: h2 } = renderMarkdown('![x](file:///etc/passwd)', file);
    expect(h2).not.toContain('src="file:');
    expect(h2).toContain('data-render="img-unavailable"');
  });
});

describe("hostile renders (T1/T3/T4)", () => {
  it("xss-script: no scripts or handlers; raw HTML escaped and marked", () => {
    const file = FIX("hostile-input/xss-script.md");
    const { html } = renderMarkdown(readFileSync(file, "utf8"), file);
    expect(html).not.toMatch(/<script[\s>/]/i);
    for (const tag of openingTags(html)) {
      expect(tag).not.toMatch(/\son[a-zA-Z]+\s*=/i);
      expect(tag).not.toMatch(/<img/i);
    }
    // The raw markup is visible to the user, escaped, and marked.
    expect(html).toContain("data-render=\"raw-html\"");
    const decoded = decodeAngleEntities(html);
    expect(decoded).toContain("<script>");
    expect(decoded).toContain("document.title = \"PWNED\"");
    // And it is never a LIVE tag.
    expect(html).not.toContain("<script>");
  });

  it("javascript-url: no executable href survives any variant", () => {
    const file = FIX("hostile-input/javascript-url.md");
    const { html } = renderMarkdown(readFileSync(file, "utf8"), file);
    for (const tag of openingTags(html)) {
      if (!tag.startsWith("<a")) continue;
      const href = /href="([^"]*)"/.exec(tag)?.[1] ?? "";
      expect(href, `forbidden href survived: ${href}`).not.toMatch(
        /^(javascript|vbscript|data|file|ftp|feed):/i,
      );
    }
    // The benign link from the fixture still works.
    expect(html).toContain('href="https://ok.example"');
    // Blocked links are inert: href dropped, anchor text stays visible.
    expect(html).toContain("<a>java</a>");
    expect(html).toContain("<a>js5</a>");
    // CommonMark treats <scheme:...> as an autolink for ANY scheme, so the
    // dangerous autolink is parsed as a link — and neutralized: href
    // dropped, anchor text visible, nothing executable remains.
    expect(html).toContain("<a>javascript:alert('autolink')</a>");
  });

  it("tracking-pixel: no remote src; placeholders; external link kept", () => {
    const file = FIX("hostile-input/tracking-pixel.md");
    const { html } = renderMarkdown(readFileSync(file, "utf8"), file);
    for (const tag of openingTags(html)) {
      const src = /src="([^"]*)"/.exec(tag)?.[1] ?? "";
      expect(src).not.toMatch(/^https?:\/\//i);
    }
    expect(html).toContain('data-render="img-unavailable"');
    expect(html).toMatch(/Remote image — disabled/);
    // External LINKS are allowed (system browser on explicit click).
    expect(html).toContain('href="https://example.com/?path=%2FUsers%2Fme%2Fsecret"');
  });

  it("path-traversal: every image is scoped or inert (T3)", () => {
    const file = FIX("hostile-input/path-traversal.md");
    const { html } = renderMarkdown(readFileSync(file, "utf8"), file);
    for (const tag of openingTags(html)) {
      if (!tag.startsWith("<img")) continue;
      const src = /src="([^"]*)"/.exec(tag)?.[1] ?? "";
      // Only the scoped protocol may carry an image src.
      expect(src).toMatch(/^local-media:/);
    }
    expect(html).toContain('data-render="img-unavailable"'); // file: scheme
  });
});

describe("resource exhaustion (T2/T8)", () => {
  it("mermaid-bomb renders as bounded source fallback", async () => {
    const file = FIX("hostile-input/mermaid-bomb.md");
    const md = readFileSync(file, "utf8");
    const started = Date.now();
    const { html } = renderMarkdown(md, file);
    expect(Date.now() - started).toBeLessThan(20_000);
    // M2: mermaid fences are marked source blocks, not a live engine.
    expect(html).toContain("language-mermaid");
    expect(html.length).toBeLessThan(250_000);
  }, 30_000);

  it("deep-nesting renders within budget", async () => {
    const file = FIX("hostile-input/deep-nesting.md");
    const started = Date.now();
    const { html } = renderMarkdown(readFileSync(file, "utf8"), file);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(html.length).toBeLessThan(2_000_000);
  }, 60_000);

  it("oversized-embedded renders within budget", async () => {
    const file = FIX("hostile-input/oversized-embedded.md");
    const started = Date.now();
    const { html } = renderMarkdown(readFileSync(file, "utf8"), file);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(html.length).toBeLessThan(10_000_000);
  }, 120_000);
});
