# Architecture

M0 validation document (2026-10-29). ADRs in `docs/adr/` are normative; this file is the map.

## System overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ Tauri 2 desktop shell (one Rust process, N webview windows)         │
│                                                                      │
│  Rust core (canonical, process-lifetime)                             │
│  ├─ DocumentRegistry ──── canonical buffers, revisions, op-log       │
│  │  undo/redo, dirty state, draft-active flags (ADR-006/007)         │
│  ├─ DocumentService ───── read, revision-checked atomic save,        │
│  │                        recovery snapshots (ADR-004)               │
│  ├─ WorkspaceService ──── scoped listing, watcher, canonicalization  │
│  ├─ AssetService ──────── image import, safe relative paths          │
│  ├─ ExportService ─────── DOCX generation, HTML asset embedding      │
│  ├─ SettingsService ───── schema-versioned app data                  │
│  └─ local-media: protocol ─ scoped local image serving (ADR-005)     │
│                                                                      │
│  Web UI per window (React 19 + TS, Vite bundle)                      │
│  ├─ src/core  (framework-independent; unit-tested in Node)           │
│  │  ├─ positions   UTF-16/UTF-8 branded offsets, conversion (ADR-010)│
│  │  ├─ buffer/tx   edit ops, localized application, validation       │
│  │  ├─ source-map  remark AST → block ranges with U16 offsets        │
│  │  ├─ serializers per-construct Markdown serializers (ADR-002)      │
│  │  ├─ draft       inline draft sessions (ADR-008)                   │
│  │  └─ close       exit-path resolution state machine (ADR-008)      │
│  ├─ features/ documents · editor (CM6) · preview (react-markdown)    │
│  │            · visual (block surface, M3V+) · outline · workspace   │
│  ├─ services/ typed facade over Rust commands + event subscriptions  │
│  └─ components/ shell, tabs, sidebar, toolbar, dialogs               │
└──────────────────────────────────────────────────────────────────────┘
```

## Data flow

**Open:** dialog/drop/CLI path → `documents_open` (Rust) → byte read, UTF-8 validation, BOM/newline detection (ADR-010) → registry entry created (revision 0) → `DocumentSnapshot` returned → frontend mirror built.

**Edit (any mode, any window):** frontend computes ops in U16 → converts to byte ops → `documents_apply_transaction(doc_id, base_revision, ops)` → Rust validates (revision + char boundaries) → applies → bumps revision → broadcasts `document-updated` to all windows → every view applies the same ops to its local cache. Keystrokes within a window are serialized through a local op queue; the ack of op N precedes dispatch of N+1 (ADR-006).

**Mode switch:** pure view change. Zero transactions, zero undo entries, zero bytes touched (invariant I1). Position restoration maps via the source-map's block ranges; on unsafe mapping, cursor lands at nearest safe boundary (§1B.2, AT-102).

**Save:** coordinator checks `dirty` → `documents_save(doc_id, expected_disk_revision)` → temp write + sync + disk revision re-check → atomic rename → `saved_revision = new disk revision`, `dirty=false`, recovery snapshot cleaned. Conflict ⇒ original untouched, resolution flow (ADR-004, AT-108).

**Visual edit (M3V+, ADR-002):** block component edit → serializer produces replacement text for that block only → one localized transaction on `[start,end)` → same registry path as every other edit. Unsupported constructs ⇒ protected blocks ⇒ inline source editor only.

## Key invariants (test-enforced from M1/M3V onward)

1. **Byte fidelity of non-edit:** open→save without edits is byte-identical (BOM, endings, trailing newline) — FR-003, NFR-005.
2. **Smallest safe region:** any edit's transaction range ⊆ the edited construct's source range. Unrelated bytes never change.
3. **One history:** document undo/redo is the registry op log; mode switches and previews add nothing (ADR-007 I1–I5).
4. **Drafts are inert:** until Apply, a draft changes nothing canonical (content, dirty, history, file).
5. **No silent loss:** every exit path runs the ADR-008 state machine; crash paths are covered by snapshots.
6. **Scoped I/O:** no frontend file access outside audited commands; all paths canonicalized + scope-checked (ADR-005, NFR-009).

## Repository layout

Per PRD §16, with one addition: `src/core/` (framework-independent document engine) — justified by PRD §8.2 ("separate document state from view state", "implement file I/O out of UI components", "mock in tests") and §17.4 ("keep domain logic independent of React").

```
src/
  core/        # framework-independent document engine (the M3V surface)
  app/         # composition, tab/window state, command wiring
  components/  # reusable presentation (tabs, sidebar, toolbar, dialogs)
  features/    # documents · editor · preview · visual · outline · workspace · export
  services/    # typed Tauri command facade + event subscriptions
  styles/      # themes, print styles
  tests/       # cross-cutting tests (fixture validation, golden renders)
src-tauri/
  src/{documents,workspace,assets,export,settings}
  capabilities/
fixtures/
  markdown/            # representative corpus (golden render, M3V edits)
  markdown/roundtrip/  # byte-exact open→save cases (BOM, CRLF, mixed, CR, …)
  markdown/edit-preserving/  # input+expected pairs for localized edits
  hostile-input/       # security corpus (XSS, URLs, bombs, traversal)
  filesystem/          # workspace fixtures (assets, symlinks) + generator
docs/
  prd.md · architecture.md · threat-model.md · test-plan.md · adr/
```

## Milestone → code correspondence

| Milestone | Adds |
|---|---|
| M0 | This scaffold, ADRs, threat model, fixtures + fixture-validation tests, CI |
| M1 | `documents`/`workspace`/`settings` Rust services; registry; shell (tabs, menus, windows, dirty UI); recovery; watcher; durability tests |
| M2 | `preview` feature (pipeline, sanitization, highlighting, outline, themes, `local-media:`) |
| M3 | `editor` feature (CM6 source, split, mode toolbar, find, shared undo wiring) |
| M3V | `src/core` source-map/serializers/draft + `visual` prototype; the fidelity gate suite |
| M4 | Full visual surface, inline editors (Mermaid/math/tables), frontmatter, scroll sync, workspace tree, link validation, image paste |
| M5 | `export` (HTML/PDF/DOCX), spell check, settings UI, docs, benchmarks |
| M6 | Platform installers, webview parity verification |

## Wireframes

Text wireframe per PRD §7.1 (single left sidebar with Files/TOC tabs, four-mode toolbar, status bar). High-fidelity mockups are an M1 task alongside the shell implementation; the §7.1 diagram is the binding information architecture.
