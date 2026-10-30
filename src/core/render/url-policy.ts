/**
 * The single audited URL policy (ADR-003, threat T1/T4, FR-022/FR-023).
 *
 * One function decides whether a URL found in document content may be used,
 * and what it may be used for. Used by the reader (urlTransform + img/link
 * components), and later by exports and link validation (FR-027) — there is
 * deliberately no second copy of this logic anywhere.
 *
 * Allowed (document content):
 *  - `#fragment`            in-document navigation
 *  - relative references    resolved against the containing document
 *                           (FR-023: never the process working directory)
 *  - `local-media:`         scoped custom protocol (Rust, T3)
 *  - `http:` / `https:`     links only — open in the system browser on
 *                           explicit user click; NEVER loaded by the webview
 *  - `mailto:`              links only
 *
 * Blocked (everything else, fail closed):
 *  - `javascript:`, `vbscript:`, any other exotic scheme
 *  - `file:`                unsolicited local-file reads (T3)
 *  - `data:`                inline payload vectors (T1) — including URLs with
 *                           embedded control characters, which are
 *                           normalized before the scheme check
 *  - `http(s)` as an IMAGE  remote images are off by default (T4)
 */

export type UrlKind = "fragment" | "relative" | "localMedia" | "remote" | "mailto" | "blocked";

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * Decode the HTML-entity tricks used to smuggle blocked schemes through
 * Markdown (`java&#115;cript:`, `javascript&colon;`, `java&amp;#115;cript:`).
 * Iterated to a fixpoint so nested encoding cannot hide a scheme. For scheme
 * detection only.
 */
function decodeEntities(url: string): string {
  let out = url;
  for (let i = 0; i < 5; i++) {
    const next = out
      .replace(/&#(\d+);/g, (_, d: string) => {
        const n = Number(d);
        return Number.isFinite(n) && n >= 0 && n <= 0x10ffff
          ? String.fromCodePoint(n)
          : "";
      })
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => {
        const n = Number.parseInt(h, 16);
        return Number.isFinite(n) && n >= 0 && n <= 0x10ffff
          ? String.fromCodePoint(n)
          : "";
      })
      .replace(/&colon;/gi, ":")
      .replace(/&amp;/gi, "&");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Classify a URL from document content. Pure and total: unknown shapes are
 * `blocked`, never guessed.
 *
 * Scheme detection runs on a normalized view: control characters are
 * stripped (browsers ignore \0–space in schemes: "java\tscript:" is
 * javascript:) and HTML entities are decoded. `safeUrl` returns the RAW
 * string for allowed kinds, so legitimate spaces in relative paths survive.
 */
export function classifyUrl(rawUrl: string): UrlKind {
  const forScheme = decodeEntities(rawUrl.replace(/[\u0000- ]/g, ""));
  if (forScheme === "") return "blocked";
  if (forScheme.startsWith("#")) return "fragment";

  const schemeMatch = SCHEME_RE.exec(forScheme);
  const scheme = schemeMatch?.[1]?.toLowerCase();
  if (!scheme) return "relative";
  switch (scheme) {
    case "http":
    case "https":
      return "remote";
    case "mailto":
      return "mailto";
    case "local-media":
      return "localMedia";
    default:
      // javascript:, vbscript:, file:, data:, ftp:, ... all blocked.
      return "blocked";
  }
}

/**
 * The value to actually put in a DOM attribute. Blocked URLs return `""`
 * (react-markdown drops empty hrefs), so a hostile link renders inert and
 * visible-as-text, never executable.
 */
export function safeUrl(rawUrl: string, usage: "link" | "image"): string {
  const kind = classifyUrl(rawUrl);
  switch (kind) {
    case "fragment":
    case "mailto":
      return usage === "link" ? rawUrl : "";
    case "localMedia":
      return usage === "image" ? rawUrl : "";
    case "relative":
      // Relative refs resolve against the document (caller computes the
      // local-media: URI for images; links open via the app).
      return rawUrl;
    case "remote":
      // Remote LINKS are fine (system browser, explicit click); remote
      // IMAGES are tracking vectors and stay off (T4).
      return usage === "link" ? rawUrl : "";
    case "blocked":
      return "";
  }
}
