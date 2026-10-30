# ADR-007: One document-wide undo/redo history in the registry; ephemeral draft histories in the frontend

**Status:** Accepted (M0, 2026-10-29)
**PRD trace:** §1B.2, §1A.3, FR-040, §1A.5.3/7, AT-103, AT-110

## Context

PRD requires a **single document-wide undo/redo history shared between Source and Visual** across mode changes *and* across windows editing the document; Read/Split previews never add entries; undo/redo must not undo a mode switch. Separately, each inline source editor draft has its own undo/redo that exists only for that editing session and is destroyed on close.

## Decision

Two strictly separated history mechanisms:

### 1. Document history (canonical, shared, Rust-side)

- Lives in the `DocumentRegistry` entry (ADR-006) as stacks of `Transaction` objects — the exact ops that were applied.
- **Undo** = apply the inverse of the last transaction (Insert ↔ Delete, Replace ↔ Replace with prior text) as its own internal transaction (new revision, new undo-group marker so "undo of undo" is redo). **Redo** symmetric.
- Because a transaction is the unit of grouping, each of these is *one* undo step:
  - a Source-mode edit burst (CodeMirror change listener batches per user-event tick into one transaction),
  - a Visual-mode block edit (one localized transaction by construction — ADR-002),
  - an inline-draft **Apply** (explicitly one transaction — §1A.3, AT-110).
- Undo/redo are **registry operations**, so they are automatically shared by all windows and all modes, and mode switches (view-only, zero transactions) add no entries — AT-103 falls out of the design.
- Undo/redo clear the opposite stack, as standard.
- Boundaries: positions in the inverse are captured *at apply time* (we store the replaced text and exact range), so later transactions cannot invalidate an inverse — each inverse is computed from the buffer state immediately after the forward apply. (Equivalent to storing old/new text per op.)
- Persistence: the op log is **in-memory only**. Undo history is not part of recovery snapshots (PRD does not require restoring undo depth across restarts; snapshots restore content only — documented limitation).

### 2. Inline draft history (ephemeral, frontend-side)

- Each inline source editor session owns a CodeMirror document initialized from the immutable opening snapshot, with CM's history extension enabled — this *is* the draft undo/redo.
- **Revert** (reset to opening snapshot, keep open, *undoable within the draft*) is implemented as a single CM change from current draft → snapshot, so it participates in the draft history exactly as §1A.3 requires: "Revert is itself undoable using the draft's independent undo history."
- Apply/Cancel/Close **destroy** the CM instance and its history (acceptance test §1A.5.7).
- The draft history never touches the registry. Only Apply produces a document transaction.

### Invariants (all asserted in tests)

- `I1` No transaction ⇒ no undo entry. Mode switch, scroll, render, preview update: zero entries.
- `I2` Applying an unchanged draft closes with **no** transaction, no dirty change.
- `I3` Document undo after a Visual Apply reverses exactly the applied range; unrelated bytes untouched (AT-110, §1A.5.3).
- `I4` Draft history length is unbounded during the session; it is gone after close. Document history is unaffected by open/close of drafts.
- `I5` Undo/redo are available from any window showing the document; all windows reflect the same history position.

## Alternatives considered

- **Frontend-held history in the active window:** breaks cross-window sharing (AT-104) and dies with the window.
- **Whole-buffer snapshots per undo:** simple but memory-hungry on 1 MB+ documents (NFR-002 territory) and makes "one Apply = one undo" trivial but storage O(docs × history).
- **Shared CM instance across windows:** not possible; CM lives per-webview.

## Consequences

- CodeMirror's own history is disabled in Source mode; the CM change listener emits ops → `documents_apply_transaction` (grouped per user event). Keystroke latency is bounded by one IPC round-trip per event tick (ADR-006; validated by the M3 latency gate).
- `documents_undo` / `documents_redo` commands take no args beyond doc_id (optionally `steps`); they return the new content delta so windows update views.
- The "stale revision" error is the only multi-writer failure mode; UI maps it to a "document changed elsewhere — reload view" notice, never a data overwrite.
