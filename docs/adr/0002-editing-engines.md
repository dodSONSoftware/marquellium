# ADR-002: CodeMirror 6 for Source/inline editing; block-mapped visual editor for Visual mode

**Status:** Accepted (M0, 2026-10-29); visual-engine choice to be *re-validated by the M3V gate*
**PRD trace:** §8.1 ADR-002, §1B.2, §1A.2, §1B.7, M3V (mandatory gate), FR-011/FR-012A/FR-052/FR-053

## Context

PRD ADR-002 requires CodeMirror 6 for Source and inline source editing, and states that Visual mode needs "an independently evaluated structured editing adapter (ProseMirror/Tiptap/Milkdown or equivalent), with source-range mapping and localized Markdown patches. Do not select a visual engine solely on rendering quality: lossless unrelated-source preservation is a gating acceptance test."

The governing principle is **correctness and document integrity before editing convenience** (§1B). The M3V gate demands: switch-without-edit is byte-for-byte stable; edited elements do not rewrite unrelated source; transition/draft tests pass. If unmet, we stop and document alternatives rather than silently degrading.

## Decision

1. **Source mode and all inline source editors use CodeMirror 6**, with its history extension *disabled* in favor of the shared document undo model (ADR-007). Inline draft sessions get an isolated CM document with its own independent history, destroyed on close (§1A.3).

2. **Visual mode v1 uses a purpose-built block-mapped editing surface** ("equivalent" under PRD ADR-002) rather than a general WYSIWYG document model:
   - The canonical Markdown is parsed with the unified/remark pipeline (ADR-003), which yields an MDAST where **every node carries byte-stable source positions** (start/end line + offset, converted to UTF-16 offsets at the core boundary — ADR-010).
   - The visual document is a **list of top-level block components**, each owning a source range `[start, end)` in the canonical buffer.
   - Editing a supported block (paragraph, heading, list, table, blockquote, emphasis/link inside them) produces **serialized Markdown for that block only**, which is applied as a localized transaction replacing exactly `[start, end)`. No full-document parse/serialize ever happens (§1A.2, §1B.3).
   - **Unsupported/unknown constructs** (raw HTML, wikilinks, callouts, obsidian embeds, directives, anything the serializer does not cover) render as **protected source-editable blocks**: visually distinct, editable only through the inline source editor with draft semantics (ADR-008). They are never dropped or normalized (NFR-005).
   - **Mode switching never rewrites source**: switching is a view operation over the same canonical buffer; the visual tree is derived, never serialized back.

## Alternatives considered

- **ProseMirror + custom markdown bridge:** full WYSIWYG document model; source preservation requires a whole-document serializer (or a partial source map). ProseMirror's model is lossy for arbitrary Markdown; preserving *unrelated* bytes requires tracking every unmodeled construct. High risk of exactly the data-loss failure the PRD gates against; highest effort.
- **Tiptap:** ProseMirror-based with a Markdown serializer; same whole-document-rewrite risk; weaker position-mapping story for source ranges.
- **Milkdown (WangEditor CRDT/CM6 bridge):** CM6-embedded with a mdast source-map; the closest off-the-shelf fit, but its source preservation is best-effort and its extension model couples editing to a live WYSIWYG state, making the "smallest safe region" contract hard to *prove*. We would inherit its fidelity instead of owning the fidelity invariant.
- **Custom block-mapped surface (chosen):** the fidelity invariant is structural — unrelated ranges are untouched by construction because writes are range-restricted, revision-checked transactions. The editing convenience cost (no arbitrary cross-block rich-text selection; per-block inline source editors for complex content) is exactly the "editing convenience" the PRD allows us to trade. The surface composes with the same remark AST, the same CodeMirror inline editors, and the same draft/transaction machinery, so the M3V gate tests the actual production path, not a throwaway prototype.

Re-validation point: after M3V, if the block surface proves insufficient for the editing convenience needed (e.g., cross-block selection is a blocker for real users), we will document measured gaps and revisit ProseMirror with the M3V fidelity suite as the regression bar. That is a decision with data, not a silent degradation.

## Consequences

- `src/core` (framework-independent TS) owns: block range mapping, per-construct serializers, localized apply, validation, draft sessions. Unit-tested in isolation; this is the M3V deliverable surface.
- The serializer must be **round-trip conservative**: if it cannot reconstruct a construct exactly, that construct is routed to the protected path instead of being rewritten. "Fail closed" per §1B.7.
- Inline source editors (Mermaid, tables, math, code, protected blocks) share one component with Revert/Cancel/Apply semantics (ADR-008).
- CodeMirror 6 remains the workhorse for Source mode, Split's source pane, and every inline source editor — one engine, two roles.

## M3V gate linkage

The M3V acceptance tests (§1A.5 items 1–8, §1B.8 AT-102/103/110–112) run against this exact architecture. Failure ⇒ stop, report, re-architect (per §1B.7 and M3V definition).
