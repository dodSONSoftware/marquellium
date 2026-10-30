# ADR-004: Filesystem is the source of truth; app data for settings/recovery/recent files

**Status:** Accepted (M0, 2026-10-29)
**PRD trace:** §8.1 ADR-004, §8.4, FR-006, FR-044, §1B.5

## Context

The app must persist user state without becoming a document database. Documents are plain files the user can edit with any other tool; the app must coexist safely with external editors (§1B.5, AT-108).

## Decision

- **Documents:** the files on disk are the only canonical store. No SQLite, no proprietary format, no indexing of repository content (PRD ADR-004).
- **App data** (in the OS app-data directory via `dirs`):
  - `settings.json` — schema-versioned settings (appearance, fonts, default mode, spell-check, sidebar state…). Schema version + migration function on load; unknown keys preserved, not dropped.
  - `recent.json` — recent file paths; unavailable paths are shown but omitted gracefully on access (FR-004).
  - `session.json` — last session's open tabs, per-tab mode, window layout; restored on next launch (FR-033). Restore never overwrites current disk content; restored dirty state comes from recovery snapshots.
  - `recovery/` — debounced recovery snapshots per document (`<hash-of-path>.md.snap` + metadata JSON: path, mtime, content hash, created at). **Snapshots are separate from the original file** and are the crash-recovery mechanism (FR-006, NFR-004). Restore is **opt-in** (explicit prompt); snapshots are cleaned on successful save and on explicit discard; bounded quota (LRU by age, default cap 500 MB) with oldest-eviction.
  - Untitled (unsaved-location) documents get snapshots too, so closing the app with an untitled dirty document is recoverable.
- **Save path (M1, §8.4):** write temp file in the destination directory → flush/sync → **re-read disk revision** (mtime-ns + size + SHA-256) → compare to `expectedDiskRevision` → atomic rename over target (same filesystem; we do *not* claim cross-filesystem atomicity) → preserve original permissions where supported. On conflict: report `conflict`, original file untouched, UI enters the external-change resolution flow.
- **Recovery snapshot cadence:** debounced ~2 s after last edit, plus an immediate snapshot before operations that may lose state (save attempt, external reload, quit-with-dirty if prompt is cancelled repeatedly). Writes are atomic (temp+rename) so a crash never leaves a torn snapshot.

## Consequences

- `DocumentsService` (Rust) is the only code path that touches user files; all operations scoped and unit/integration-tested (M1 gate).
- Settings schema changes require a migration test (FR-034).
- Recovery is *not* autosave: the user's file on disk is only changed by explicit Save (§1B.5).
