# ADR-010: Coordinate system, encoding boundary, and byte-fidelity rules

**Status:** Accepted (M0, 2026-10-29)
**PRD trace:** §1B.7, §8.3, FR-051, AT-116, FR-003 (BOM/newline/trailing-newline preservation)

## Context

TypeScript strings and CodeMirror positions are **UTF-16 code units**; Rust `String`/`&[u8]` positions are **UTF-8 bytes**. Mixing them silently corrupts documents containing astral characters (emoji, CJK Extension B, ZWJ sequences). The PRD mandates: explicitly typed/branded offsets, revision-checked, bounds-checked, converted only at dedicated boundaries; reject offsets splitting surrogate pairs or invalid UTF-8 boundaries; never silently round.

## Decision

### Types

```ts
// src/core/positions.ts — branded, cannot be mixed with plain numbers
export type U16 = { readonly __brand: "u16"; readonly value: number }; // UTF-16 code units
export type Byte = { readonly __brand: "byte"; readonly value: number }; // UTF-8 bytes
```

- All `src/core` APIs (buffer, ranges, serializers, source edits) are typed in `U16` against the canonical TS mirror.
- The wire format to Rust (ADR-006 ops) uses **UTF-8 byte offsets** + UTF-8 text. The *only* conversion points are:
  - `u16ToByte(content, pos)` / `byteToU16(content, pos)` in `src/core/positions.ts`, which **throw** on positions that split a surrogate pair (TS side) and Rust rejects op boundaries that fall mid-char (byte side). AT-116 tests both rejections.
  - remark position (1-based line/col) → `U16` at parse time, once, via a precomputed line-offset table.
- Every transaction is revision-checked end-to-end: frontend mirror revision → Rust `base_revision` check → new revision broadcast. A mismatch is a hard error, not a coercion.

### BOM

- Detected at read (Rust): leading `EF BB BF` ⇒ `bom: true`; BOM **stripped** from the canonical buffer, flag persisted in the registry entry and snapshot metadata. Save re-prepends the BOM iff `bom` was true at open (or the user explicitly toggled encoding — M5 settings). Unmodified open→save is therefore byte-identical (FR-003, fixture `roundtrip/bom.md`).
- Non-UTF-8 content (Latin-1 etc.): detected at read (UTF-8 validation failure or heuristic on replacement chars) ⇒ **explicit conversion flow or refusal; never mutate silently** (§1B.7). v1: refuse with a clear error offering "open with conversion" (iconv-style best-effort, user-visible, creates a dirty document, never touches the original until Save).

### Line endings

- **No normalization on load** (§8.4). The canonical buffer keeps whatever the file had, including mixed endings.
- `newline: dominant` is computed at open (LF vs CRLF vs CR, by count) and stored; used only to choose the ending for **newly introduced** line breaks (typing in Source, serializer output for new lines inside a regenerated block).
- A block serializer must reproduce the line endings *as found inside that block*; if a block's ending is ambiguous (single line), it uses the block's original (none) — i.e. it cannot introduce line endings into a one-line block. This is what makes "unrelated formatting remains unchanged" (§1A.5.2) true for mixed-ending files (fixture `roundtrip/mixed-endings.md` + edit-preserving tests).
- Trailing newline: preserved exactly. If the document ends without one, serializers that append a block at end-of-document must not add one (block range replacement handles this structurally: replacing `[start,end)` never touches `end+1`).

### Surrogates / graphemes

- Editing APIs accept only `U16` positions that do not split surrogate pairs; validation is in `positions.ts` and unit-tested against the `fixtures/markdown/unicode.md` corpus (emoji ZWJ, combining marks, surrogate pairs).
- Source operations retain code-point-safe, byte-faithful coordinates. M3V localized Visual transactions additionally reject replacement boundaries inside a grapheme (including combining marks and ZWJ sequences), matching the stricter PRD edit-safety requirement. This validation does not normalize text or change the coordinate system; unsafe Visual edits fail closed. This M3V clarification supersedes the original blanket allowance for mid-grapheme core edits.

### File-size guard

- Default open limit 10 MB (configurable later); exceed ⇒ actionable error, no partial state.

## Consequences

- `src/core` is the only TS module allowed to own `U16`/`Byte` values; React/CodeMirror adapters convert at their edges.
- Rust side validates op boundaries with a precomputed char-boundary check (single pass, cached per revision) — O(1) amortized per op.
- Test matrix (AT-116, FR-051): surrogate-split rejection (both sides), CRLF/BOM/mixed/trailing-newline round-trips, unicode edit at every code-point class, stale-revision rejection.
