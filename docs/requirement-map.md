# Requirement → Task Map

PRD §17.1: "produce a requirement-to-task map, explicitly identifying unmet dependencies or security issues." Statuses: `M0` planned/started now, `M1`… as per PRD §11. `✅ M1` / `✅ M2` = delivered and test-covered in that milestone's gate.

## Document lifecycle (FR-001…009)

| FR | Task | Component | Milestone | Dependencies |
|---|---|---|---|---|
| FR-001 | Open .md/.markdown/UTF-8; dialog + drop + OS Open With | `documents` (Rust), shell | ✅ M1 (dialog + open) + M3 (native drag & drop via core `tauri://drag-drop`, .md/.markdown/.txt, actionable errors) — OS Open With / CLI file-open: M6 macOS and installed Debian arm64 verified; Windows acceptance open (see `m6-results.md`) | — |
| FR-002 | New/save/save-as/close, dirty state | `documents` + shell tabs | ✅ M1 | registry (ADR-006) |
| FR-003 | Byte-identical round-trip, BOM/endings/trailing newline | DocumentService + ADR-010 rules | ✅ M1 (re-verified at M3V) | roundtrip fixtures |
| FR-004 | Tabs + recent files, graceful missing-path handling | shell + `session` (Rust) | ✅ M1 tabs (close, missing-path) + M3 (drag-reorder, persisted recents in empty state, unavailable files pruned via `files_exist`, dead entry prunes on click) | — |
| FR-005 | External modification handling (reload/compare/save-copy) | watcher + resolution flow | ✅ M1 (watcher, clean auto-reload, dirty prompt, save-conflict dialog) | registry, close state machine (ADR-008) |
| FR-006 | Crash recovery snapshots (debounced, opt-in restore, cleanup) | recovery in `documents`/app-data | ✅ M1 (debounced snapshots, startup prompt, restore-as-untitled, discard, quota LRU) | ADR-004 |
| FR-007 | Folder/workspace mode, tree, excludes | `workspace` | ✅ M4 — per-window picker-granted folder tree, lazy expansion, bounded exclusions, hidden/symlink omission | scoped paths |
| FR-008 | Image paste → assets dir, relative URI path, no overwrite | `assets` | ✅ M4 — explicit native RGBA clipboard → adjacent PNG assets, unique create-new names, encoded relative Markdown | scoped paths |
| FR-009 | TextBundle/TextPack | — | P2 (explicit non-goal for v1.0) | threat model T14 |

## Views and editing (FR-010…019, FR-040…048, FR-051…054)

| FR | Task | Component | Milestone | Dependencies |
|---|---|---|---|---|
| FR-010 | Read mode | `reader` (React, ADR-003 plugins) | ✅ M2 | ADR-003 pipeline |
| FR-011 | Source mode (CM6, highlight, wrap, undo via shared history) | `editor` | ✅ M3 (byte-op groups → one registry transaction; net-diff commit pins the registry pre-batch contract) | ADR-007 |
| FR-012 | Split mode, adjustable divider, debounced preview | `editor`+`preview` | ✅ M3 (draggable divider 20–80%, 200 ms preview debounce, sync toggle) | — |
| FR-012A | Visual mode (source-preserving, protected fallbacks) | `visual` + `src/core` | ✅ M4 — rendered supported text/containers/tables; source drafts for structural/code/math edits; protected unknowns | ADR-002, M3V fixtures |
| FR-012B | 4-mode switch, position preservation, per-tab mode memory | shell + source-map | ✅ M3 (view stays mounted across switches; cursor/selection survive; per-tab mode persisted via FR-033) — normal Visual enabled at M4 | — |
| FR-013 | Editing commands (bold/italic/link/heading/list/quote/fence/task) | `editor` commands | ✅ M3 (toolbar + keybindings, selection mapping) | — |
| FR-014 | Outline (H1–H6, highlight, Unicode/duplicate headings) | `outline` + slug module | ✅ M2 (left-sidebar TOC, collapsible + user-resizable + persisted — pulled forward from M3 at user request; active-heading highlight M3) | — |
| FR-015 | Find/replace (current doc; source context) | `editor` | ✅ M3/M4 (CM search in Source/Split; safe native Find route from Read/Visual) | — |
| FR-016 | Bidirectional scroll sync | source-map | ✅ M4 — bidirectional raw source-block mapping, CRLF coordinate adapter, re-entrancy guard and toggle | M3V mapping |
| FR-017 | Table helpers (insert, add/remove row/col, alignment, escaped pipes) | `core` table module + visual | ✅ M4 — insert/add/remove rows/columns, alignment, escaped-pipe preservation, bounded validation | M3V |
| FR-018 | Command palette | shell | ✅ M4 — filtered keyboard palette, disabled-command filtering, focus restoration | — |
| FR-019 | Focus/typewriter | shell | P2 | — |
| FR-040 | Shared undo/redo + ephemeral draft histories | registry + `core/draft` | ✅ M3 (document side: Mod-Z/Shift-Mod-Z → registry; edit-group granularity), M3V (draft side) | ADR-007/008 |
| FR-041 | Cursor/selection preservation across modes | source-map | ✅ M3 (basic: diff-mapped selection across mode switch), M3V (visual) | — |
| FR-042 | Configurable default mode (initially Visual) | settings + shell | ✅ M4 — fresh default Visual, selectable default, explicit saved Source/session modes preserved | M3V |
| FR-043 | Multi-window + tabs, coordinated ownership | registry + shell windows | ✅ M1 (views, shared entry via `find_by_path`, close guard) | ADR-006 |
| FR-044 | Manual save, indicators, recovery | shell + registry | ✅ M1 | — |
| FR-045 | Unsaved prompts (tab/window/quit), failed-save semantics | close state machine | ✅ M1 | ADR-008 |
| FR-046 | File monitoring, clean auto-reload, dirty prompt | watcher | ✅ M1 | — |
| FR-047 | Single left sidebar (Files/TOC), resizable/collapsible, persisted | shell | ✅ M2 (TOC section: collapsible, user-resizable drag, persisted via settings — pulled forward from M3 at user request; Files section + section switcher M4 with workspace mode) | — |
| FR-048 | Appearance/font/size/spacing/max-width settings | settings + styles | ✅ M5 — persistent preferences, independent editor font/size, cross-window updates | — |
| FR-051 | UTF-16/UTF-8 boundary, Unicode-safe edits, revision validation | `core/positions` + registry | ✅ M1 (boundary validation both sides), M3V (edit safety) | ADR-010 |
| FR-052 | Source-preserving visual transactions, protected constructs | `core` serializers + visual | M3V | ADR-002 |
| FR-053 | Inline draft Revert/Cancel/Apply | `core/draft` + editor | M3V | ADR-008 |
| FR-054 | Cross-window close/draft resolution state machine | close coordinator | ✅ M1 (canonical part + wiring), M3V (draft part) | ADR-008 |

## Rendering (FR-020…029)

| FR | Task | Milestone |
|---|---|---|
| FR-020 | CommonMark+GFM fixtures | ✅ M2 (golden corpus green, incl. hostile fixtures) |
| FR-021 | Code highlighting (known langs, plain fallback, copy) | ✅ M2 (hljs core + pinned language set; unknown → escaped plain; copy via clipboard plugin) |
| FR-022 | Safe renderer | ✅ M2 (raw HTML escaped-by-construction, URL policy single source, hostile renders pinned) |
| FR-023 | Local link/image resolution (doc-relative, scoped) | ✅ M2 (doc-dir-relative → absolute `local-media:`; Rust scope-check + magic-byte sniff; fail closed) |
| FR-024 | Mermaid (strict, non-destructive fallback) | ✅ M4 — strict isolated flowchart/sequence/class previews in Read/Visual, validated source drafts and last-valid fallback |
| FR-025 | KaTeX | ✅ M4 — bounded KaTeX with trust disabled inline/display rendering and validated math source drafts |
| FR-026 | Frontmatter (raw preserved, compact display) | ✅ M4 — raw frontmatter preserved, compact metadata card, persistent visibility control, dialect-consistent outline |
| FR-027 | Link validation (missing files/anchors; no network) | ✅ M4 — local files and Markdown anchors, references, scope checks, no remote traversal |
| FR-028 | Exports HTML/PDF/DOCX | ✅ M5 implementation — static HTML, native Print/Save PDF, native DOCX with visible fallbacks; native Debian export/cancel and independent LibreOffice inspection passed in [release follow up](release-follow-up-2026-11-02.md); release gate remains open |
| FR-029 | Dialect profiles | P2 |

## UI/preferences (FR-030…036, FR-049, FR-050, FR-055)

| FR | Task | Milestone |
|---|---|---|
| FR-030 | Responsive shell, native menus, high-DPI | ✅ M1 (native menus incl. accelerators, windows), M5 (polish) |
| FR-031 | Themes (system/light/dark, coordinated palettes) | ✅ M2 (reader + code palettes, light/dark coordinated; toolbar light/dark toggle with system tracking — pulled forward from M5; full preferences UI delivered M5) |
| FR-032 | Typography settings | ✅ M5 — document font/size/spacing/measure and independent editor font/size |
| FR-033 | Session restore (tabs, layout, per-tab mode; never clobber unsaved) | ✅ M3 (schema-versioned `session.json`; restores file tabs + per-tab mode + active; untitled excluded so restore can't clobber unsaved — recovery owns that, FR-006; pure mapping pinned in `session.test.ts`) |
| FR-034 | Preferences persistence + reset | ✅ M5 — validated bounds, unknown key preservation, reset/save, native dialog focus |
| FR-035 | Document statistics (words/chars/read time) | ✅ M5 — debounced worker, Unicode code-point count, approximate words/read time |
| FR-036 | Custom CSS | P2 |
| FR-049 | Native spell check + enable/disable | ✅ M5 macOS — real WebKit suggestions enabled/disabled in native acceptance, no source rewrite |
| FR-050 | Export fidelity (duplicates FR-028 with fidelity fixtures) | ✅ M5 fixture content/ZIP/XML/native PDF checks; Word layout and platform print parity remain limited |
| FR-055 | Workspace-wide search | ✅ M4 — picker-scoped, exclusion-aware literal disk search with bounded line results and explicit truncation/skips |

## NFRs

| NFR | Task | Milestone |
|---|---|---|
| NFR-001/002/003 | Launch/open/typing benchmarks on documented baseline | M5 — 30 native fresh-process runs/3000 dispatches; exact boundaries and remaining cache limits in `m5-results.md` |
| NFR-004 | Fault injection (crash, disk-full, interrupted write, external edit) | ✅ M1 (atomic-save, stale-save, torn-snapshot, external-edit tests) |
| NFR-005 | 100% unsupported-construct retention (fixture round-trip) | M3V (gate), enforced forever |
| NFR-006 | Offline suite (no network) | ✅ M2 spot (structurally offline: no fetch path, CSP `connect-src 'self'`, remote images placeholdered; manual offline spot-check in gate), M5 full |
| NFR-007 | Keyboard operation of core workflows | M3 (core), M5 (QA checklist) |
| NFR-008 | No telemetry by default | by construction (no telemetry code path exists); verified M5 |
| NFR-009 | Scoped path validation (negative tests) | ✅ M1 (Rust traversal/symlink negative tests) + M2 (`local-media:` protocol: traversal/symlink/malformed/oversized/non-media all fail closed, tested) |
| NFR-010 | Release builds + signing | M5 (macOS), M6 (Win/Linux) |

## Unmet dependencies / security issues identified at M0

1. **FR-042 sequencing resolved at M4:** M3V retained Source while its bounded prototype was reviewed. M4 now enables normal Visual editing and makes it the fresh default, retaining explicit saved Source/session choices. See `m4-results.md`.
2. **DOCX math fidelity** has no offline, dependency-light solution (ADR-009): v1 documents a TeX-source fallback rather than claiming KaTeX parity. This is the only mandatory-format fidelity gap; it is surfaced in the export UI, not hidden.
3. **Windows/Linux webview print (PDF)** is a portability risk (ADR-009) — macOS path is solid; M6 gate must validate or document.
4. **Mermaid security posture** requires a standing advisory-watch task at every release (threat T2); encoded in the M5 checklist.
5. **`@types/highlight.js` version skew** (10.x types vs 11.x runtime): types cover the API surface we use; a pinning note — if a gap appears in M2, regenerate via DefinitelyTyped bump. Trivial, tracked.
6. No requirement needs a backend service, network, or account — confirmed by construction (PRD §1B.1 satisfied by ADR-004/005).

## M1 completion notes (explicit deferrals, not silent)

1. **FR-033 session restore → M3.** The M1 shell does not persist the tab list across restarts; crash-time *content* is covered by FR-006 recovery snapshots (M1). The PRD's own M3 scope ships "tab state" (tabs, per-tab mode, layout), so FR-033 is scheduled there with the constraint "never clobber unsaved" carried over. This reassignment is documented here rather than silently dropped.
2. **FR-004 recent-files list → M3.** Tabs, close, and missing-path handling are M1; the persisted recent-files UI lands with FR-033's session store.
3. **M1 edit granularity.** The Source textarea commits one full-buffer registry transaction per keystroke (undo granularity = keystroke). This is the documented M1 path; M3's CodeMirror adapter replaces it with minimal diffed ops batched per edit group through the *same* transaction path (ADR-006/007). No correctness property is weaker in M1 — every keystroke still goes through revision-checked validation.
4. **Default mode is Visual** for fresh settings/documents as of M4. Existing explicit Source preferences and session modes are retained (FR-042).
5. **Open-alias canonicalization.** `documents_open` canonicalizes paths, so symlinked or `..`-laden opens of the same file share one registry entry across windows (FR-043).

## M2 completion notes (explicit deferrals, not silent)

1. **FR-024/FR-025 (Mermaid, KaTeX) → M4.** M2 renders both as *marked source blocks* — the exact "non-destructive fallback" FR-024 names: source preserved, visibly labeled ("Mermaid diagram — rendered in a later milestone"), budgeted, no engine executed. The live engines (sandboxed Mermaid with the T2 advisory watch, KaTeX) are M4; the pipeline's `mathToSource`/`rawHtmlToCode`-style plugins and the reader's `data-render` markers were designed so M4 swaps component internals without touching the pipeline or golden outputs' invariants.
2. **FR-014 outline surface.** M2 ships the outline data in the persistent **left sidebar** (FR-047 TOC section — pulled forward from M3 at user request): collapsible (toolbar + in-panel), user-resizable by drag (180–560 px), and persisted via the settings store's pre-existing `sidebar` field. Active-heading scroll highlighting remains M3. In Source mode the sidebar lists heading counts but click-to-scroll is inert (no rendered headings on screen).
3. **`local-media:` URI contract.** The TS pipeline emits *absolute* URIs only (`local-media:/abs/path`, per-segment percent-encoded); the Rust handler rejects anything not absolute, then canonicalizes (symlink-resolving) and scope-checks against parent dirs of open documents, then magic-byte-sniffs (png/jpeg/gif/webp/bmp/svg; SVG allowed — inert inside `<img>`). Everything else fails closed with 404. 20 MB cap.
4. **Unavailable images demote to `<span data-render="img-unavailable">`** — no `<img>` ever carries a blocked/remote src, so the element cannot fetch (T4). Reason text is human-readable and mirrored in `aria-label`.
5. **GFM autolink behavior.** GFM 1.0 (as implemented by remark-gfm and current GitHub) autolinks `www.` domains → `http://`. The M0 fixture's pre-1.0 expectation was corrected; bare `example.com` (no scheme, no `www`) stays plain text. Footnote ids carry remark-gfm's `user-content-` prefix (matches GitHub's DOM); ref↔definition hrefs stay consistent.
6. **Bundle size note (not a gate item).** The web bundle is a single ~508 kB chunk (hljs + react-markdown + app). Code-splitting (dynamic import of the reader/mermaid/katex) is scheduled with M5 polish; no functionality or security property depends on it.
7. **Offline spot check (NFR-006).** Structural: the reader makes zero network requests (no `fetch`/`XMLHttpRequest`/`import()` of remote; remote images become placeholders; CSP `connect-src 'self'`, `img-src 'self' local-media:`). The test plan's manual offline spot check (dev app, network off, open a corpus doc + a hostile doc) is the remaining gate action.
8. **Theme toggle (FR-031) pulled forward from M5.** Toolbar light/dark switch (sun/moon) writes `appearance` to the persisted settings store (Tauri app-data JSON, localStorage in browser dev); `system` follows live OS changes via `matchMedia`. This also fixed a latent bug: startup set `data-theme=""` for `system`, whose empty attribute still matched the CSS `[data-theme]` selector, pinning light tokens on dark-mode systems. `system` now *removes* the attribute so the media query decides. Full preferences UI (fonts, spacing, max-width) stays M5.
