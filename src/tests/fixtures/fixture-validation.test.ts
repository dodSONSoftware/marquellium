/**
 * M0 gate — fixture corpus validation (PRD §11 M0, docs/test-plan.md).
 *
 * The fixture corpus is the binding test input for every later milestone
 * (golden renders M2, M3V fidelity, AT-115 exports). This suite fails the
 * build if:
 *   - a required fixture is missing (inventory),
 *   - a parseable corpus file no longer parses (M2+ depends on this),
 *   - a byte-exactness fixture loses its byte properties (BOM/CRLF/CR/…),
 *   - hostile fixtures are incomplete (security coverage silently eroded).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, lstatSync, existsSync } from "node:fs";
import { join } from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";

const ROOT = join(__dirname, "..", "..", "..");
const FIX = (p: string) => join(ROOT, "fixtures", p);

/** Files that are NOT valid UTF-8 by design (Rust-side refusal flow, T7). */
const EXPECTED_INVALID_UTF8 = new Set([
  "fixtures/hostile-input/invalid-utf8.md",
]);

const CORPUS = "markdown";
const HOSTILE = "hostile-input";

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkFrontmatter);

describe("fixture inventory (M0 gate)", () => {
  const required = [
    // representative corpus
    `${CORPUS}/gfm-full.md`,
    `${CORPUS}/common-markdown.md`,
    `${CORPUS}/unicode.md`,
    `${CORPUS}/mermaid-math.md`,
    `${CORPUS}/frontmatter.md`,
    `${CORPUS}/unsupported-constructs.md`,
    `${CORPUS}/code-heavy.md`,
    `${CORPUS}/links-images.md`,
    `${CORPUS}/large-1mb.md`,
    // byte-exactness
    `${CORPUS}/roundtrip/crlf.md`,
    `${CORPUS}/roundtrip/bom.md`,
    `${CORPUS}/roundtrip/bom-crlf.md`,
    `${CORPUS}/roundtrip/no-trailing-newline.md`,
    `${CORPUS}/roundtrip/mixed-endings.md`,
    `${CORPUS}/roundtrip/trailing-spaces.md`,
    `${CORPUS}/roundtrip/cr-only.md`,
    `${CORPUS}/edit-preserving/crlf-input.md`,
    `${CORPUS}/edit-preserving/crlf-expected.md`,
    `${CORPUS}/edit-preserving/bom-input.md`,
    `${CORPUS}/edit-preserving/bom-expected.md`,
    `${CORPUS}/edit-preserving/mixed-input.md`,
    `${CORPUS}/edit-preserving/mixed-expected.md`,
    `${CORPUS}/edit-preserving/no-trailing-input.md`,
    `${CORPUS}/edit-preserving/no-trailing-expected.md`,
    // security corpus
    `${HOSTILE}/xss-script.md`,
    `${HOSTILE}/javascript-url.md`,
    `${HOSTILE}/tracking-pixel.md`,
    `${HOSTILE}/path-traversal.md`,
    `${HOSTILE}/mermaid-bomb.md`,
    `${HOSTILE}/deep-nesting.md`,
    `${HOSTILE}/oversized-embedded.md`,
    `${HOSTILE}/invalid-utf8.md`,
    `${HOSTILE}/null-byte.md`,
    // workspace + export
    `filesystem/workspace-a/README.md`,
    `filesystem/workspace-a/assets/diagram.png`,
    `filesystem/workspace-a/docs/guide.md`,
    `filesystem/workspace-a/docs/sub/api.md`,
    `export/export-fixture.md`,
  ];

  it("all required fixtures exist and are non-empty", () => {
    const missing = required.filter(
      (p) => !existsSync(FIX(p)) || statSync(FIX(p)).size === 0,
    );
    expect(missing, `missing or empty fixtures: ${missing.join(", ")}`).toEqual([]);
  });

  it("workspace fixture contains its symlinks", () => {
    for (const link of [
      "filesystem/workspace-a/link-to-guide.md",
      "filesystem/workspace-a/broken-link.md",
    ]) {
      const st = lstatSync(FIX(link), { throwIfNoEntry: false });
      expect(st?.isSymbolicLink(), `${link} should be a symlink`).toBe(true);
    }
  });
});

describe("corpus parseability (input contract for M2 golden + M3V)", () => {
  const files = listMarkdownFiles(FIX("markdown")).map((f) =>
    f.slice(ROOT.length + 1),
  ); // root-relative, e.g. "fixtures/markdown/gfm-full.md"

  it("found the expected corpus files", () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it.each(files)("%s parses without throwing", (rel) => {
    const buf = readFileSync(join(ROOT, rel));
    const fatal = new TextDecoder("utf-8", { fatal: true });
    expect(
      () => fatal.decode(buf),
      `${rel} should be valid UTF-8`,
    ).not.toThrow();
    expect(() => parser.parse(fatal.decode(buf))).not.toThrow();
  });

  it("large-1mb.md meets the 1 MB benchmark size (NFR-002 input)", () => {
    expect(statSync(FIX(`${CORPUS}/large-1mb.md`)).size).toBeGreaterThanOrEqual(
      1_000_000,
    );
  });
});

describe("hostile corpus", () => {
  const files = listMarkdownFiles(FIX(HOSTILE)).map((f) =>
    f.slice(ROOT.length + 1),
  ); // root-relative

  it.each(files)("%s has valid-UTF-8 status matching its design", (rel) => {
    const buf = readFileSync(join(ROOT, rel));
    const ok = (() => {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(buf);
        return true;
      } catch {
        return false;
      }
    })();
    const shouldBeInvalid = EXPECTED_INVALID_UTF8.has(rel);
    expect(ok, `${rel}: expected ${shouldBeInvalid ? "invalid" : "valid"} UTF-8`).toBe(
      !shouldBeInvalid,
    );
  });

  it("mermaid-bomb contains a ≥5000-edge diagram (resource-exhaustion input, T2)", () => {
    const text = readFileSync(FIX(`${HOSTILE}/mermaid-bomb.md`), "utf-8");
    const edges = (text.match(/--> /g) ?? []).length;
    expect(edges).toBeGreaterThanOrEqual(5000);
  });

  it("null-byte.md is valid UTF-8 but embeds U+0000 (content-hostile, not encoding-invalid)", () => {
    const text = readFileSync(
      join(ROOT, "fixtures", HOSTILE, "null-byte.md"),
      "utf-8",
    );
    expect(text).toContain("\u0000");
  });

  it("path-traversal covers the canonical attack shapes (T3)", () => {
    const text = readFileSync(FIX(`${HOSTILE}/path-traversal.md`), "utf-8");
    for (const needle of ["../../", "%2F", "\\..\\", "file://", "/etc/passwd"]) {
      expect(text).toContain(needle);
    }
  });
});

describe("byte-exactness fixtures (FR-003 input contract)", () => {
  const read = (p: string) => readFileSync(FIX(p));

  it("crlf.md: every line ending is CRLF, no bare LF", () => {
    const b = read(`${CORPUS}/roundtrip/crlf.md`);
    const text = b.toString("binary");
    expect(text).toContain("\r\n");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(b[0]).not.toBe(0x0a);
  });

  it("bom.md and bom-crlf.md: start with the UTF-8 BOM", () => {
    for (const p of [
      `${CORPUS}/roundtrip/bom.md`,
      `${CORPUS}/roundtrip/bom-crlf.md`,
    ]) {
      const b = read(p);
      expect(Array.from(b.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    }
  });

  it("no-trailing-newline.md: does not end with a newline", () => {
    const b = read(`${CORPUS}/roundtrip/no-trailing-newline.md`);
    expect(b[b.length - 1]).not.toBe(0x0a);
    expect(b[b.length - 1]).not.toBe(0x0d);
  });

  it("mixed-endings.md: contains both LF-only and CRLF lines", () => {
    const text = read(`${CORPUS}/roundtrip/mixed-endings.md`).toString("binary");
    expect(text).toContain("\r\n");
    // an LF that is not preceded by CR
    expect(text.replace(/\r\n/g, "\x00")).toContain("\n");
  });

  it("cr-only.md: CR endings with no NUL-terminated CRLF", () => {
    const text = read(`${CORPUS}/roundtrip/cr-only.md`).toString("binary");
    expect(text).toContain("\r");
    expect(text).not.toContain("\r\n");
    expect(text).not.toContain("\n");
  });

  it("edit-preserving pairs: input ≠ expected, and expected carries the edit", () => {
    // Each probe: (inputText, expectedText) → true iff the expected file
    // contains exactly the intended edit marker (the M3V suites will assert
    // the *unrelated-region* invariants against these pairs).
    const pairs: Array<[string, (input: string, expected: string) => boolean]> = [
      [
        `${CORPUS}/edit-preserving/crlf`,
        (_i, e) => /# Edited/m.test(e) && !/# Edit Me/m.test(e),
      ],
      [
        `${CORPUS}/edit-preserving/bom`,
        (i, e) => /First paragraph CHANGED\./.test(e) && /First paragraph\./.test(i),
      ],
      [
        `${CORPUS}/edit-preserving/mixed`,
        (i, e) =>
          /lf-line ends with LF\. CHANGED\ncrlf-line ends with CRLF\.\r\n/.test(e) &&
          /lf-line ends with LF\.\ncrlf-line ends with CRLF\.\r\n/.test(i),
      ],
      [
        `${CORPUS}/edit-preserving/no-trailing`,
        (i, e) => /CHANGED$/.test(e) && !/CHANGED$/.test(i),
      ],
    ];
    for (const [base, probe] of pairs) {
      const input = read(`${base}-input.md`).toString("utf-8");
      const expected = read(`${base}-expected.md`).toString("utf-8");
      expect(expected).not.toBe(input);
      expect(probe(input, expected), `pair ${base} probe failed`).toBe(true);
    }
  });
});
