# ADR-003: unified/remark/rehype pipeline with react-markdown; raw HTML escaped by default

**Status:** Accepted (M0, 2026-10-29)
**PRD trace:** §8.1 ADR-003, §8.5, §15.3 (HTML handling), FR-020–FR-023, §5 (P1: Mermaid/KaTeX)

## Context

The renderer must tokenize GFM, produce a safe AST/DOM, support extensions, and provide source-position mappings for outline/scroll sync and (critically) for the visual-mode block ranges (ADR-002). Security: no scripts, event handlers, dangerous URLs, or unsolicited local-file reads (FR-022, NFR-009).

## Decision

- **Parse:** `unified` + `remark-parse` (CommonMark) + `remark-gfm` (tables, task lists, strikethrough, autolinks, footnotes) + `remark-math` (`$`/`$$`) + `remark-frontmatter` (YAML, kept as raw text — FR-026).
- **Render:** `react-markdown` + `remark-rehype`. `react-markdown` does **not** apply `rehype-raw`, so raw HTML in documents is **dropped from the DOM by default** — but per §15.3 we *prefer escape by default*: the preview renders raw HTML nodes as an escaped, visibly-marked `<code>`-styled block (a custom `raw` component), so the user sees the markup rather than a silent omission. No setting re-enables raw HTML in v1.
- **Sanitization/URL policy:** react-markdown's `urlTransform` plus an explicit policy module: allow `http`, `https`, `mailto`, `#fragment`; allow relative and `local-media:` URIs (see below); block everything else (`javascript:`, `vbscript:`, untrusted `data:` including with control characters, `file:`). The policy is a single audited function used by preview, exports, and link validation (FR-027).
- **Code highlighting:** highlight.js on fenced code; unknown language ⇒ escaped plain text (FR-021). Copy button per block.
- **Mermaid:** fenced `mermaid` blocks render via a dedicated component in Mermaid **strict** security mode with controlled config and render-time budget; failure ⇒ non-destructive fallback showing the source with a diagnostic (FR-024, §8.5, §10.2).
- **Math:** KaTeX for inline/block math; parse failure ⇒ styled fallback with source, never a crash (FR-025).
- **Local media:** images/links resolve relative to the *containing document* (FR-023). They are served through a **scoped custom protocol handler** (`local-media:`) implemented in Rust that canonicalizes the path and verifies it stays inside the document's workspace scope (ADR-005) — never through a broad filesystem protocol. Remote images are **off by default** (PRD §8.5, §15.1): the `img-src` CSP contains no `https:` for document content; enabling is a documented, explicit preference (M5 decision point).
- **Positions:** MDAST node positions (1-based lines/offsets from remark) are converted to UTF-16 char offsets in `src/core` and carried in block ranges (ADR-010). This is the mapping substrate for outline, scroll sync (M4), and visual editing.

## Alternatives considered

- **rehype-raw + rehype-sanitize (restricted subset):** keeps a small HTML subset renderable, but sanitizer allowlists are an ongoing security-maintenance burden and the PRD (§15.3) prefers escape-by-default. Revisit in P2 if demand emerges.
- **Direct micromark/custom renderer:** more control, far more code, no React integration. Rejected.
- **shiki over highlight.js:** higher-fidelity highlighting (tree-sitter) but WASM init cost and theme-asset complexity; highlight.js is synchronous and trivially testable. Revisit if highlighting quality is a user complaint (P2).

## Consequences

- Golden fixture tests (M2) compare rendered structure (hast/HTML string) against checked-in expectations for the whole corpus in `fixtures/markdown/`, with documented known GitHub divergences kept in `docs/test-plan.md`.
- The renderer is pure (string in → hast out) and fully testable in Node (Vitest) without the webview.
- Exports (ADR-009) reuse the same pipeline and URL policy; exported HTML inherits the sanitizer decisions (PRD §8.5).
