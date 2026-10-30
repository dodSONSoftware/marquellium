# ADR-009: Export — HTML via the render pipeline; PDF via webview print; DOCX generated in Rust

**Status:** Accepted (M0, 2026-10-29); DOCX generator spike lands in M5
**PRD trace:** §1B.6 (HTML/PDF/DOCX mandatory), FR-028/FR-050, AT-115, §15.2 (PDF engine spike)

## Context

v1.0 **must** export HTML, PDF, and DOCX (§1B.6). The PRD makes the PDF/DOCX backend choice an M0 spike/ADR "not a reason to remove the requirement", and requires fidelity fixtures for headings, links, images, tables, code, math, and Mermaid, with clearly documented limitations and *no silent omission of essential content* (AT-115).

## Decisions (spike conclusions)

### HTML — same pipeline, static output (high confidence)

- Reuse the M2 renderer: `unified` → `rehype-stringify` (or render-to-HTML in Node-equivalent path in the webview), then wrap in a standalone document with **inlined CSS only** — no scripts, no remote references (inherits ADR-003 sanitizer and URL policy; exported HTML is safe to email).
- Local images: embedded as `data:` URIs (raster/SVG) so the file is self-contained; relative links are preserved as relative links (documented: they resolve against the original folder).
- Mermaid: rendered to SVG during preview; the SVG is inlined into the export (static image — acceptable, documented).
- Math: KaTeX SVG output inlined.
- **Feasible: yes.** No open risks.

### PDF — webview print-to-PDF (medium-high confidence; portability is the open item)

- macOS: WKWebView print-to-PDF (Tauri exposes print via the webview; we drive it with a print stylesheet: A4/Letter, margins, page numbers in the template). The rendered DOM (SVG diagrams, KaTeX SVG) prints faithfully — same pixels as preview.
- Alternatives rejected: headless Chromium in the bundle (adds ~150 MB, violates lightweight/local-first intent), a Rust PDF writer (re-implementing layout — infeasible at quality parity), Pandoc dependency (PRD defers Pandoc, §5).
- Limitations to document: pagination of tables/figures, no interactive links beyond standard PDF links, font substitution on non-macOS. **Windows (WebView2) and Linux (WebKitGTK) print behavior must be validated in M6** — this is the portability risk, not the macOS path.
- **Feasible: yes on macOS; Windows/Linux parity is an M6 gate item.**

### DOCX — Rust generator from the Markdown AST (medium confidence; spike in M5)

- **Approach:** parse with `pulldown-cmark` (GFM enabled) in Rust, map events to a minimal OOXML document (`word/document.xml`, styles, numbering), zip with the `zip` crate. Output is a small, auditable generator; no heavyweight dependency, works fully offline.
- **Feasible mappings:** headings (styles), paragraphs, emphasis, links (hyperlinks), lists (numbering definitions), tables (OOXML tables), code blocks (monospace shaded paragraphs), images (embedded parts when the file exists and is raster; SVG ⇒ rasterized in the webview before handoff).
- **Documented v1 limitations (never silent — each has a visible fallback in the output):**
  - **Math:** KaTeX has no DOCX backend. v1 emits the math in its TeX source inside a monospace, boxed paragraph + an explanatory note on first occurrence. (Option for a later release: OMML conversion — significant effort, deferred.)
  - **Mermaid:** v1 emits the diagram source in a monospace block with a caption. Optional enhancement: rasterize the preview SVG to PNG and embed the image *in place of* the source (keep both if trivial); decision during M5 spike.
  - **Task lists:** rendered as lists with ☐/☞ prefix text (DOCX has no native checkbox without Word extensions).
  - **Raw HTML / unsupported constructs:** rendered as their source text in a monospace block (consistent with the protected-constructs philosophy; nothing dropped).
- **Alternative rejected:** `docx-rs` builder crate — higher-level but less transparent for fidelity control; re-evaluate only if the hand-rolled generator underperforms the fidelity fixtures.
- **Feasible: yes** for the required content classes, with the documented math/Mermaid fallbacks. The M5 spike produces a DOCX from the `fixtures/export/` corpus and diffs it against the fidelity expectations (AT-115).

## Consequences

- `ExportService` (Rust) owns DOCX generation and file writing; HTML generation lives in TS (pipeline reuse) and is handed to Rust for asset embedding + write; PDF is a print pass over the preview DOM.
- `fixtures/export/` (created in M0) is the binding corpus for AT-115 across all three formats.
- Export UI (M5) shows the documented limitation list so users are never surprised (PRD: "clearly document platform/format limitations").
