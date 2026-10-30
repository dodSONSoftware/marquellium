# ADR-006: Single in-process document registry in Rust; op-based transactions and broadcast

**Status:** Accepted (M0, 2026-10-29)
**PRD trace:** §1B.1, §1B.5, §1B.7, AT-104, AT-117, FR-043

## Context

Multiple native windows may display the same document. PRD §1B.1 requires "coordinated canonical state or explicit conflict protection; never allow independent unsynchronized buffers to overwrite one another" and recommends: "single in-process document registry shared by all windows and consistent transaction broadcasts."

## Decision

**The canonical document state lives in the Rust process**, in a `DocumentRegistry` (`std::sync` guarded, one entry per canonical path / untitled doc id):

```rust
DocEntry {
  doc_id: DocId,
  path: Option<PathBuf>,
  content: String,            // canonical UTF-8, no BOM (BOM tracked in metadata)
  bom: bool,
  newline: NewlinePolicy,     // dominant convention at open; preserved on edit (1B.7)
  revision: u64,              // monotonic; bumped per applied transaction
  saved_revision: Option<DiskRevision>,  // mtime-ns + size + sha256 at last save
  disk_revision: Option<DiskRevision>,   // last observed on disk
  dirty: bool,
  undo/redo: op-log stacks    // see ADR-007
}
```

**Transactions are ops, not snapshots:**

```
DocOp      = { kind: Insert | Replace, startByte: u32, endByte: u32, text: String }
Transaction = { base_revision: u64, ops: Vec<DocOp> }   // applied atomically, one undo group
```

Flow for an edit (from any window):
1. The window's frontend computes the edit in UTF-16 offsets, maps to **UTF-8 byte offsets** (its local mirror is revision-checked against the registry — ADR-010), and sends `documents_apply_transaction { doc_id, base_revision, ops }`.
2. Rust validates `base_revision == entry.revision` and that all op boundaries are valid UTF-8 char boundaries within `len`. Stale ⇒ `Err(StaleRevision)`, nothing mutated; the frontend reconciles (rebase or conflict surface).
3. Rust applies ops atomically, bumps `revision`, appends the transaction to the undo stack (clearing redo), sets `dirty`, emits `document-updated { doc_id, revision, transaction }` to **all** windows.
4. The originating window applies locally optimistically for latency; the ack/broadcast confirms. Ordering is preserved by requiring `base_revision` equality — a lost-race sender is rejected and must resubmit against the new revision (single-writer-at-a-time per keystroke; keystrokes within one window are serialized through its local op queue).

**Why Rust-side canonical state (vs. electing a "leader window"):**
- A leader window dies if its webview is closed/crashed; the Rust registry is process-lifetime and survives any window event.
- Close/shutdown coordination (§1B.5, AT-105/106/117) becomes a pure Rust state machine: dirty state, inline-draft flags, and snapshot triggers are all visible in one place. The frontend close state machine (ADR-008) *asks* the registry for "are there unresolved things for doc X" instead of guessing.
- Undo/redo is trivially shared across windows and modes (ADR-007) because the op log lives next to the buffer.

**Dirty state & close:** `dirty` is true from revision > saved_revision. Closing a view decrements a refcount; canonical data persists while ≥1 window shows it (AT-117). Quit/close resolution runs once per *document*, not per view (§1B.5).

**Frontend mirrors:** each window keeps a CodeMirror/visual view synced from broadcast transactions; its local buffer is a *cache*, never authoritative. If a window is stale (missed a broadcast — shouldn't happen, but defensively), re-open by requesting the full content at current revision.

## Alternatives considered

- **Leader-window election + op broadcast:** avoids duplicating buffer logic in Rust but makes crash/close semantics fragile and puts the canonical state in a place that can be closed by the user.
- **CRDT (Yjs/WangEditor):** overkill; we need strict serial transaction semantics with revision checks, not convergence.
- **One window per document (no shared display):** violates FR-043/AT-104 explicitly.

## Consequences

- The TS `DocumentSnapshot` contract (PRD §8.3) becomes the *request/ack payload* for opens and syncs; the registry entry is the runtime truth.
- New-window cost: fetch content + revision + last N ops.
- Test surface: Rust registry tests (two "windows" as test clients applying interleaved ops) cover AT-104/117 at the contract level; E2E covers the UI.
