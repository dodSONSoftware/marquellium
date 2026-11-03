# Marquellium — Competitive Analysis and Product Requirements

**Version:** 2.0 (final product requirements; implementation handoff)  
**Research date:** 2026-10-29  
**Status:** Product requirements approved for Codex implementation; technical feasibility gates remain mandatory  
**Target:** Local-first cross-platform desktop application; macOS first  
**Product name:** TBD

## 1. Executive decision

Build a focused, local-first Markdown **viewer and editor**, including a Typora-style visual editing experience, not a general knowledge-management system. Ship four modes: **Read**, **Source**, **Split**, and **Visual**. Canonical Markdown remains authoritative; visual edits must preserve unrelated source. The feasibility and source-fidelity of the visual-editing architecture are mandatory early validation gates.

**Recommended stack:** Tauri 2 + Rust backend; TypeScript + React frontend; CodeMirror 6 editor; unified/remark/rehype rendering pipeline; Mermaid for diagrams; KaTeX for math. Versions must be pinned at implementation time after dependency/security review. The initial platform is macOS (Apple Silicon), with Windows and Linux release targets after portability verification. No backend service, user account, cloud sync, AI integration, knowledge graph, or user-installed plugin system is needed for v1.

**Primary references:** [One Markdown](https://apps.apple.com/us/app/one-markdown/id1507139439), [VS Code Markdown documentation](https://code.visualstudio.com/docs/languages/markdown), [MarkText](https://github.com/marktext/marktext), [Zettlr](https://www.zettlr.com/features), [Tauri architecture](https://tauri.app/concept/architecture/), [TextBundle spec](https://textbundle.org/spec/), [react-markdown security](https://github.com/remarkjs/react-markdown), [Mermaid configuration](https://github.com/mermaid-js/mermaid/blob/develop/docs/config/usage.md).

## 1A. Confirmed product decisions (supersede earlier provisional assumptions)

**Decision status:** Confirmed in stakeholder interview through October 29, 2026. This section takes precedence over any older three-mode or WYSIWYG-deferral language elsewhere in the document.

### 1A.1 Modes and switching

- Four modes: **Read** (render only), **Source** (raw Markdown editor), **Split** (source + rendered preview), **Visual** (direct editing of rendered content, Typora-style).
- Expose four persistent, visible toolbar mode buttons and keyboard shortcuts (exact bindings TBD).
- Switching modes preserves the approximate document position and editing context, using document/source anchors rather than naive scroll percentages where possible.
- Each open document/tab remembers its selected mode independently while open. Newly opened documents use the configurable default mode, initially **Visual**. Restored session tabs retain their session mode.
- Mode changes must not save, serialize, normalize, discard, or reformat source by themselves.

### 1A.2 Visual-mode content contract

- Paragraphs, headings, lists, emphasis and links: edit in place.
- Mermaid: render the diagram; reveal an **inline source editor below** with live diagram preview.
- GFM tables: cells editable directly, with context menus and keyboard shortcuts; also expose a control to expand/collapse an **inline Markdown source editor below** the rendered table.
- Math and fenced code: specialized inline source editing with rendered previews where applicable.
- Unknown/unsupported constructs: display **protected, explicitly source-editable blocks**. Never drop or silently normalize them.
- Source Markdown is canonical. Editing an element must not rewrite unrelated Markdown. For complex edits, replace only the smallest safe source region; no global parse/serialize rewriting on a view switch.

### 1A.3 Inline source editing: explicit transaction semantics

- Opening an inline source editor captures an immutable **opening snapshot** of that element's current canonical Markdown and creates an isolated **draft buffer with its own undo/redo history**.
- While open, present **Revert** at left and **Apply** / **Cancel** at right **at all times**. Do **not** show a separate Discard control in the inline editor.
- **Live preview** renders the valid draft in place, without committing it to the canonical document. While the draft is malformed, show validation feedback and preserve the last valid preview; malformed drafts must never overwrite canonical Markdown.
- **Apply:** validate draft, commit as **one atomic operation** to canonical Markdown, create one document-level undo entry, mark document dirty as appropriate, and close the inline editor. Disable Apply if draft is invalid; unchanged Apply may simply close with no document transaction.
- **Cancel:** discard draft changes, restore canonical rendered content, and close the inline editor. No document-level undo entry.
- **Revert:** reset draft to the **opening snapshot**, refresh preview, but **keep the editor open**. Revert is itself undoable using the draft's independent undo history, allowing recovery of edits made before Revert.
- The draft's undo/redo history exists only for the lifetime of that inline editing session and is destroyed when the editor closes. Canonical document undo/redo is independent.
- Allow at most **one inline source editor session per document** at once. Opening another editor with a modified draft first requires resolution.
- Direct visual table edits outside an inline source session update canonical Markdown using localized document transactions. While inline source editing is active for the table, canonical table edits must not race with the draft.

### 1A.4 Navigation and pending draft safeguard

- Switching to another main mode while the inline editor has **no pending changes** switches immediately, closing the clean inline session.
- Switching modes while a draft has **unapplied changes** opens a confirmation modal with **Apply / Discard / Cancel switch**. This modal is distinct from the inline editor's persistent **Revert / Apply / Cancel** buttons.
- Modal **Apply** commits the valid draft and proceeds with the mode switch; **Discard** abandons the draft and proceeds; **Cancel switch** closes the modal and leaves mode, session and draft unchanged.
- An invalid draft cannot be applied; the modal must permit returning to fix it or discarding it. Never silently discard drafts during tab closing, document closing, file reload, or application shutdown. Exact recovery persistence across crashes remains to be decided.

### 1A.5 Required acceptance tests

1. Switch across all four modes without editing: source remains byte-identical and has no unrelated dirty-state changes.
2. Edit one paragraph, table, or Mermaid definition in Visual: unrelated source ranges, custom directives, line endings and formatting remain unchanged.
3. Direct-edit a table, open its inline source editor, make a valid draft, observe live preview, Apply, then continue direct visual editing; one document-level undo reverses the Apply.
4. Make a malformed Mermaid/table draft: original canonical Markdown remains unchanged, diagnostics appear, Apply is blocked and last valid preview remains.
5. Modify draft, Revert, then undo the Revert inside the inline editor; pre-Revert draft reappears; Cancel discards all draft changes and closes.
6. Modify draft then request mode switch: modal shows Apply / Discard / Cancel switch with precisely the semantics above; no modal for clean drafts.
7. Close editor via Apply or Cancel: inline draft history is destroyed. Source/document-level history retains only committed changes.
8. Unsupported directives and embedded source constructs survive view switches and unrelated edits unchanged.

## 1B. Final stakeholder decisions and binding product contracts (October 29, 2026)

This section is normative. **Correctness and document integrity before editing convenience** is the governing principle. Where older priority labels or suggestions conflict with confirmed requirements here, **this section wins**. Codex must not trade away these contracts to achieve a superficially complete UI.

### 1B.1 Desktop packaging and platforms

- **One self-contained desktop application**, built with **Tauri 2**, Rust native capabilities, and TypeScript/React inside an OS WebView. Rust is **not a separately deployed backend service**. No daemon, HTTP service, Docker, local API server, cloud account, database, or internet connectivity is required for core functionality.
- macOS first (Apple Silicon release); Windows and Linux after portability validation. Node/Rust developer build dependencies are **not required on end-user machines**.
- Multiple native windows; multiple tabs in each window. A document opened in multiple windows must have **coordinated canonical state or explicit conflict protection**; never allow independent unsynchronized buffers to overwrite one another. Choose and document one strategy in M0; recommended: single in-process document registry shared by all windows and consistent transaction broadcasts.

### 1B.2 Four-mode lifecycle, state, and navigation

- **Read** (rendered, non-editable), **Source** (Markdown code), **Split** (source plus live preview), **Visual** (direct editing of the rendered document).
- Four always-visible toolbar buttons plus keyboard shortcuts, all discoverable in native menus. Shortcut mappings must not collide with OS-reserved accelerators and must be documented/tested.
- Switching modes is **view-only**: it neither saves nor changes Markdown bytes, dirty state, formatting, or undo history.
- Preserve current logical document location using heading/block anchors and source-map positions, preserving the cursor and selected text where mapping is valid. If exact mapping is unsafe or impossible, maintain approximate context and place the cursor at the nearest safe boundary; do not invent an editable selection.
- Mode is remembered separately for each **open tab**. On a fresh open, use **configurable default mode, initially Visual**. A restored application session can restore the previous mode associated with its restored tab; this does not change the global new-open default.
- **One document-wide undo/redo history shared between Source and Visual** across mode changes and windows editing that document. Read and Split previews never add undo entries. Undo/redo must not undo a mode switch. Distinct inline draft history is governed below.

### 1B.3 Inline source editor — precise control semantics

- Applicable to Mermaid, GFM tables, math, code, protected unsupported constructs, and other specialized blocks where safe.
- Only one active inline source draft session per canonical document at a time, including across windows. Each session captures an immutable opening snapshot, source range, and base document revision, then creates an isolated draft text and **temporary independent undo/redo stack**, destroyed at close.
- Layout is **Revert** on the left, **Cancel** and **Apply** on the right, persistently visible. **No Discard button inside the inline editor**.
- Draft text updates a **live visual preview only** after validation; until valid, show diagnostics and last valid preview. Draft edits **never** update canonical Markdown, file dirty flag, or document history before Apply. Never silently commit on collapse, focus loss, navigation, close, reload, or shutdown.
- **Revert**: restore the exact opening snapshot **without closing**, as a reversible action in the draft's own undo history. It is not a document-level undo operation.
- **Apply**: if valid and base revision/range still current, commit the smallest safe source-range change as **one atomic document undo transaction**, then close. If unchanged, simply close without dirtying. If invalid or stale, block Apply and offer actionable remediation; never overwrite concurrent changes.
- **Cancel**: discard the draft and close, leaving canonical content unchanged. Both Apply and Cancel destroy the temporary draft history.
- Direct visual table cell edits are committed as normal document transactions **only when no active inline draft covers the table**. Source editing the table shows a valid-draft live preview and returns to direct cell editing after Apply.
- Attempting to switch main mode with a modified inline draft opens **Apply / Discard / Cancel switch** modal: Apply validates/commits then switches; Discard abandons draft then switches; Cancel switch remains in current mode with draft intact. With no pending changes, simply close the inline editor and switch immediately. The same no-silent-loss principle applies to switching tabs/windows or initiating document close, reload, or app exit: resolve or preserve the draft, never abandon it invisibly.

### 1B.4 Sidebar, TOC and configuration

- One **left sidebar** with **Files** and **Table of Contents** tabs, **resizable and collapsible**. Keyboard accessibility and window-size constraints required; width, visibility, and selected section persist.
- TOC dynamically derives H1–H6, nested correctly; heading click scrolls to the heading in any mode; highlight current section; duplicate headings and Unicode titles must be stable.
- Preferences: appearance **Light / Dark / Follow System**; document **Font Name**, **Font Size**, **Line Spacing** (extra vertical separation / line-height), **Document Width** (maximum rendered/editable content width, centered where applicable); default opening mode (Visual initially); native spell-check toggle (enabled by default subject to platform support). Defaults, units, bounds, reset behavior, and persistence must be implemented and tested. Source-editor monospace typography can be independently tuned without silently changing the content font preference.
- Document width must apply consistently to Read and Visual; Split preview uses available pane width up to the configured maximum. Prefer numeric pixel input with validated bounds and responsive maximum. No preference is written into the Markdown document itself.

### 1B.5 Saving, durability, and shutdown contract

- **Manual Save by default** via Cmd+S on macOS (Ctrl+S elsewhere), Save As, and native menu. Modifications set an unsaved-change indicator on tab/window and remain dirty until a successful disk save or explicit discard.
- **Recovery snapshots** must persist unsaved canonical changes separately from original files and survive crashes/restarts. Snapshots are not a substitute for Save. Recovery restore must be opt-in and not silently overwrite disk contents. Safely handle edited untitled files.
- Closing a modified **tab, window, or the entire application** must **warn about unsaved changes and offer Save / Discard / Cancel**, with per-document scope and unambiguous filenames. On app-wide quit across multiple windows, all modified documents must be accounted for (summary or sequential prompts); Cancel must abort shutdown without losing any documents. No destructive operations until explicit resolution. A failed Save must prevent destructive closure and preserve working data.
- **Pending inline drafts are resolved before document-level save/discard/closure**. Saving must never accidentally include unapplied drafts. Before quit or closing a tab/window, resolve modified inline draft via Apply / Discard / Cancel navigation, then resolve canonical unsaved changes via Save / Discard / Cancel. Avoid nested ambiguous dialogs; implement a coordinated close state machine. OS termination/crash is addressed via snapshots, not false promises of interactive prompts.
- External file changes: **automatically reload only when canonical buffer is clean and no modified inline draft is pending**. With local unsaved changes, prompt with clear reload/keep/copy actions; avoid overwriting a changed disk revision. A stale save must fail safely (or explicitly enter resolution flow). Git checkout/rewrite, external editors, and atomic file replacement are covered.
- With one document shown in multiple windows, the unsaved prompt must be based on **canonical document ownership**, not duplicated for each view, and closing one view must not destroy shared data still open elsewhere.

### 1B.6 Output and other v1 features

- Initial release **must export HTML, PDF, and DOCX**. Define export fidelity fixtures for headings, links, images, tables, code, math, and Mermaid; clearly document platform/format limitations and never silently omit essential document content. PDF/DOCX backend choice is an M0 spike/ADR, not a reason to remove the requirement.
- **Native spell checking**, with global enable/disable setting, in editable modes where OS WebView exposes it. Test platform capability and provide a clear documented fallback; no cloud grammar service.
- Folder tree navigation, multiple tabs/windows, local image paste/relative paths, CommonMark/GFM, math, Mermaid, syntax-highlighted code, current-document find/replace and workspace-wide search, HTML/PDF/DOCX export, and outline navigation all belong in v1.0.

### 1B.7 Unicode, transactions and source-integrity contract

- **Markdown source is canonical.** TypeScript document offsets and editor selection maps use **UTF-16 code-unit offsets**; Rust byte-level operations use **UTF-8 byte offsets**. Positions are explicitly typed or branded, revision-checked, bounds-checked and converted only at dedicated boundaries. Reject offsets splitting UTF-16 surrogate pairs, invalid UTF-8 byte boundaries, or unsafe grapheme selections. Never silently round an invalid edit.
- Avoid passing offsets to Rust for routine saves: send validated complete snapshots to native persistence. Rust persists atomically and verifies disk identity/revision before replacing; preserve the original on write failure. The document engine must ensure coherent in-memory revisions across windows.
- Switching without editing must **never** change source bytes. A localized visual edit changes only the smallest safe region; unaffected source must remain unchanged, including whitespace, delimiter choice, unsupported directives, BOM and unchanged line endings. Structural edits may regenerate their **authorized construct** only, never unrelated regions. Unsupported constructs are protected, explicitly source-editable nodes; ambiguous visual changes fail closed.
- Test LF, CRLF, mixed line endings, trailing newlines, UTF-8 BOM, combining characters, emoji/ZWJ sequences, surrogate pairs and Unicode filenames. UTF-8 (with/without BOM) is the v1 editable encoding; unsupported encodings trigger an explicit conversion flow or refusal without mutation.
- Before full Visual mode, **M3V mandatory proof-of-concept** verifies faithful source↔visual mapping, safe localized modifications, consistent shared undo/redo, protected fallbacks, and transactional inline drafts. If unsatisfied, stop and report architecture alternatives instead of silently relaxing data-integrity guarantees.

### 1B.8 Acceptance criteria added by the final interview

| ID | Scenario | Required result |
|---|---|---|
| AT-101 | Freshly open file with unmodified default settings | Opens in Visual; setting can select Read/Source/Split instead |
| AT-102 | Switch modes while selection spans formatted text | Exact selection restored if safe; otherwise nearest safe context, no unintended edit |
| AT-103 | Source edit → Visual → Source → undo | Single shared history undoes the original edit; switching adds no undo entry |
| AT-104 | Two windows display same modified document | No split-brain buffer; save conflict prevented; consistent dirty markers |
| AT-105 | Close dirty tab or window | Save / Discard / Cancel; Cancel leaves state intact |
| AT-106 | Quit with dirty documents in multiple windows | All dirty documents identified; Cancel aborts quit; save failure keeps app/data open |
| AT-107 | Quit with both inline draft and dirty document | Resolve draft first, then canonical unsaved state; no silent loss or accidental draft save |
| AT-108 | External disk edit while clean vs dirty | Clean auto-reloads; dirty prompts; stale save never silently overwrites |
| AT-109 | Resize/collapse left sidebar; change Files/TOC | Layout/selection persists; no document edits; keyboard navigation works |
| AT-110 | Table inline edit → Revert → undo Revert → Apply | Opening snapshot restored by Revert; draft undo restores pre-Revert draft; Apply is one canonical undo transaction |
| AT-111 | Table inline edit → Cancel | Draft abandoned and editor closes; no canonical change/dirty flag |
| AT-112 | Mermaid/table draft invalid → switch mode | Apply disabled; Discard or Cancel switch available; document unchanged unless explicitly discarded/committed |
| AT-113 | Change font, size, spacing, max width, appearance | Views react, settings persist and never alter Markdown source |
| AT-114 | Native spell-check preference | Enable/disable behaves as supported; no network dependency |
| AT-115 | Export fixture to HTML/PDF/DOCX | Expected content preserved, no unexpected omission; documented per-format fallbacks |
| AT-116 | Unicode edits cross JS/Rust boundary | No corruption, invalid position rejected, stale revision rejected |
| AT-117 | Close one of two windows holding same dirty document | Canonical data remains alive in other window; no duplicate or destructive global prompts |

## 2. Research method and evidentiary limits

Desk research into first-party product listings, documentation, repositories, and relevant standards on October 29, 2026. Findings are documented vendor/project capabilities, **not** independent installation benchmarks. No app was installed or usability-tested. Individual feature availability may differ by product version, OS, license, or settings. Pricing and user-review counts deliberately omitted from requirements because they change. The proposed architecture and priorities are engineering recommendations, not claims made by competing vendors.

## 3. Competitive landscape

| Application | Core model | Strengths to adopt | Tradeoffs / avoid copying |
|---|---|---|---|
| One Markdown | Lightweight Markdown and TextBundle editor on Apple platforms | Full-source preservation, GFM, images, Mermaid, math, outline, themes, table tools | Apple-platform focus; not evidence of cross-platform parity or complete workspace management |
| Typora | Inline rendered editor | Highly polished single-document UX, easy tables, clean typography | WYSIWYG source round-tripping is expensive and error-prone |
| MarkText | Open-source inline editor | CommonMark/GFM, source mode, image paste, focus and typewriter modes | Use as a reference; validate preservation before committing to an editing engine |
| Obsidian | Local Markdown vault | Reading/source modes, tabs, folders, navigation, links | Avoid plugin marketplace and graph features in core |
| VS Code | Source editor with preview | Split view, heading navigation, scroll sync, path completion, link validation, external changes | Avoid IDE complexity and extension system |
| Zettlr | Research and publishing | Metadata, long-document/project workflows, rich export | Avoid citation-management scope in v1 |
| ghostwriter | Focused writing | Minimal controls, distraction-free modes | Less relevant to repository-aware operations |
| iA Writer | Focused prose | Typography and deliberate interface | Do not sacrifice technical-document capabilities |
| Joplin | Notes ecosystem | Local/offline reliability and optional sync | No proprietary data repository in v1 |
| StackEdit / HackMD | Web and collaboration | Low-friction preview and collaboration patterns | Cloud collaboration is not a v1 requirement |

### 3.1 Market opportunity

Many users want a dedicated document reader/editor, not a general-purpose IDE or personal knowledge base. Differentiate by *plain-file interoperability*, *fast startup*, *read-first design*, *no account*, *safe previews*, *accurate local links*, and *external-editor coexistence*. Cross-platform delivery broadens the target while keeping macOS the first release.

### 3.2 Key product judgments

1. **Source is canonical.** Never silently reformat entire documents on open/save.
2. **Read is first-class.** A reading mode must be comfortable enough to replace browser or IDE preview for long documents.
3. **Predictability outweighs magic.** Markdown source must remain editable even when a diagram, image, or extension fails.
4. **File interoperability matters more than a database.** Use `.md` and ordinary asset folders.
5. **Extensibility comes later.** Support a documented renderer extension seam internally without exposing executable third-party plugins.
6. **Security is part of rendering.** Treat all Markdown and Mermaid as untrusted input, even when files are local.

## 4. Product definition

### 4.1 Problem

Reading Markdown inside a code editor is visually noisy; writing it in a viewer is cumbersome; rich Markdown often renders differently across applications; local images and links can break; and simplistic editors can overwrite externally changed documents. Users need one lightweight app that makes the document the center of the experience while retaining safe, non-lossy file handling.

### 4.2 Vision

A dependable desktop home for Markdown documents: open any local Markdown file, read it beautifully, edit it efficiently, and save it without unexpected transformations.

### 4.3 Target personas and jobs to be done

- **Software engineer:** inspect and edit READMEs, design docs, PRDs, runbooks, and architecture diagrams in Git repositories.
- **Technical writer:** write long GFM documents, navigate outlines, inspect tables, and export shareable HTML/PDF.
- **General Markdown user:** double-click a Markdown file and read it without configuring a developer tool.
- **Research/documentation reviewer:** rapidly switch among files, search and read comfortably, without cloud accounts.

### 4.4 Goals

G1. Open/read common Markdown files immediately and offline.  
G2. Preserve source fidelity and reliably save local files.  
G3. Render GFM, fenced code, Mermaid, math, images, and local links safely.  
G4. Provide fast source editing and synchronized split preview.  
G5. Deliver accessible macOS-first desktop UX with portable architecture.  
G6. Support standard folders and external-file modifications safely.

### 4.5 Non-goals for v1

Unrestricted rich-text/HTML authoring beyond Markdown; note graph/backlinks; custom executable plugins; hosted collaboration; sync service; AI features; MDX/JSX execution; ECharts scripting; arbitrary embedded HTML execution; Zotero and citation integration; full Git client; publishing CMS; mobile; end-to-end encrypted cloud storage.

## 5. Release priorities

**P0 / MVP:** four-mode framework (Read/Source/Split/Visual), source-preserving visual prototype; file open/new/save/save-as; tabs; recent files; GFM; safe sanitized preview; basic code highlighting; local/remote images under explicit policy; document outline; find; light/dark themes; Markdown shortcuts; dirty indicators; crash recovery; external-change conflict protection; keyboard accessibility.

**P1 / v1.0:** complete supported visual editing (paragraphs/lists/tables/embedded element source editors), folder sidebar/workspace; Mermaid and KaTeX; image paste/drag-drop; link navigation and validation; synchronized scroll; frontmatter display; export **HTML/PDF/DOCX**; settings; file-system monitoring; table editing helpers; command palette; **native spell check with enable/disable preference; workspace-wide search**.

**P2 / v1.x:** TextBundle import/export; textpack; custom CSS/themes; optional read-only export CLI; document diff/merge; improved performance for massive files; link-update assistance on rename.

**Explicitly deferred:** unrestricted HTML-like WYSIWYG constructs not representable in Markdown; cloud sync; collaboration; AI; plugins; ECharts (runtime and security complexity); graph visualization; Pandoc integration until demand established.

## 6. Functional requirements

The following IDs are stable traceability identifiers for implementation issues and tests. Acceptance criteria are binding for their priority tier.

### 6.1 Document lifecycle

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-001 | P0 | Open `.md`, `.markdown`, and UTF-8 plain-text documents | File dialog, OS Open With, drag/drop and CLI file-open integration where supported; actionable errors |
| FR-002 | P0 | Create, save, save as, and close documents | Save is explicit by default; modified tabs show dirty state; close prompts for unsaved work |
| FR-003 | P0 | Preserve source bytes where practical | Opening and saving unchanged document produces byte-identical file; preserve BOM, newline convention, trailing newline, and encoding where supported |
| FR-004 | P0 | Tabs and recent-document history | Tabs can be reordered/closed; recent entries omit unavailable files gracefully |
| FR-005 | P0 | External modification handling | Watch file; do not silently overwrite; offer reload / compare-or-preserve / save copy; changed-on-disk detection before write |
| FR-006 | P0 | Crash recovery | Debounced recovery snapshots outside original path; restored state clearly identified; snapshots cleaned on successful save/explicit discard |
| FR-007 | P1 | Folder/workspace mode | Open directory; list Markdown files; tree navigation; exclude user-configured patterns |
| FR-008 | P1 | Image paste | Persist clipboard image in chosen adjacent assets folder; insert relative URI-encoded Markdown path; no overwrites |
| FR-009 | P2 | TextBundle / TextPack | Import/export specification-compliant packages and preserve unrelated metadata; safely reject path traversal and oversized archives |

**Source-preservation nuance:** Byte-identical round-trip for unmodified documents is mandatory. For edited documents, preserve original UTF-8 BOM and newline convention unless user explicitly converts them; unsupported encodings must be detected and handled without silent data loss. Source-preserving visual editing for supported syntax is in scope; unsupported syntax must remain protected and editable as source.

### 6.2 Views and editing

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-010 | P0 | Read mode | Render Markdown with no editing controls in content area; keyboard link navigation and selectable text |
| FR-011 | P0 | Source mode | CodeMirror-based editable source, syntax highlights, line numbers optional, undo/redo, indentation, wrapping |
| FR-012 | P0 | Split mode | Source and preview side-by-side, adjustable divider; live preview debounced; no cursor loss during updates |
| FR-012A | P0 | Visual mode | Direct editing of rendered supported Markdown, with source-preserving operations and protected fallbacks for unsupported syntax |
| FR-012B | P0 | Mode switching | Four visible buttons and keyboard shortcuts; preserve approximate content position; selected mode remembered for each open document |
| FR-013 | P0 | Editing commands | Bold, italic, links, images, headings, lists, quotations, fences, tasks; selection-aware operations |
| FR-014 | P0 | Document outline in left Files/TOC sidebar | Hierarchical H1–H6 navigation; current heading highlighted; Unicode and duplicate headings supported |
| FR-015 | P0 | Find/replace | Search current document, keyboard shortcuts, next/previous, replacement only in source/edit context |
| FR-016 | P1 | Scroll synchronization | Bidirectional mapping between source location and preview headings/blocks; disableable; no oscillation |
| FR-017 | P1 | Table helpers | Insert table; add/remove row/column in GFM table; preserve alignment and escape pipes safely |
| FR-018 | P1 | Command palette | Discoverable commands with keyboard-driven filtering |
| FR-019 | P2 | Focus/typewriter modes | Hide surrounding chrome and optionally center active paragraph |

### 6.3 Markdown rendering

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-020 | P0 | CommonMark + GFM | Fixtures cover headings, links, references, tables, tasks, strikethrough, autolinks, nested lists, blockquotes, fences and footnotes |
| FR-021 | P0 | Code highlighting | Language-aware highlighting for common languages; unknown language falls back to escaped plain code; copy code |
| FR-022 | P0 | Safe renderer | No scripts, event handlers, dangerous URLs, or unsolicited local-file reads from Markdown |
| FR-023 | P0 | Local link/image resolution | Resolve relative to containing document, not process working directory; explicit policy for outside-workspace paths |
| FR-024 | P1 | Mermaid | Render supported fenced diagrams with strict security; invalid diagrams show non-destructive source/error fallback |
| FR-025 | P1 | KaTeX | Inline `$...$` and block `$$...$$` math; invalid expression cannot crash editor |
| FR-026 | P1 | Frontmatter | Recognize YAML frontmatter but preserve raw text; preview can show compact metadata or hide by setting |
| FR-027 | P1 | Link validation | Identify missing local files and anchors; no network traversal for external links |
| FR-028 | P1 | Exports | HTML, PDF and DOCX with themes, diagrams, math and local images where renderable; no scripts in exported HTML |
| FR-029 | P2 | Extended dialect profiles | Explicit GitHub / CommonMark profiles, with documented, tested renderer differences |

**Compatibility:** GFM is the default, with explicit additions for math, Mermaid, and YAML frontmatter. Rendering will not perfectly match GitHub in all cases; ship fixtures documenting known divergences. Wikilinks, callouts, Obsidian-specific embeds, raw ECharts blocks, and MDX are not implicitly enabled.

### 6.4 User interface and preferences

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-030 | P0 | Responsive desktop shell | Native menus, multiple windows, resizable panes, tabs, standard open/save shortcuts, proper high-DPI behavior |
| FR-031 | P0 | Themes | Follow System/light/dark mode; readable contrast; code and preview use coordinated palettes |
| FR-032 | P0 | Typography | Configurable document font name, size, line spacing and max document width; independent monospaced editor font |
| FR-033 | P0 | Session restoration | Restore open tabs and layout; never overwrite unsaved content on restore |
| FR-034 | P1 | Preferences | UI settings persisted locally, no account; reset-to-default |
| FR-035 | P1 | Document statistics | Word/character count and approximate reading time, updated without blocking typing |
| FR-036 | P2 | Custom CSS | User-selected trusted stylesheet only; scope styles to preview; disallow remote imports by default |

### 6.5 Final requirement IDs (binding additions)

| ID | Priority | Requirement |
|---|---|---|
| FR-040 | P0 | Shared cross-mode undo/redo; dedicated ephemeral inline draft undo/redo |
| FR-041 | P0 | Cursor and text selection preserved where safely mappable across modes |
| FR-042 | P0 | Default fresh-open mode configurable, initially Visual |
| FR-043 | P0 | Multiple native windows and tabs with coordinated document ownership |
| FR-044 | P0 | Manual Save, unsaved indicators, crash-recovery snapshots |
| FR-045 | P0 | Unsaved-change prompts for tab/window/app quit; safe cancel and failed-save semantics |
| FR-046 | P0 | External file monitoring, clean auto-reload, dirty conflict prompting |
| FR-047 | P0 | Single collapsible/resizable left sidebar with Files and TOC tabs |
| FR-048 | P0 | Appearance, font family/size, line spacing and max document width settings |
| FR-049 | P1 | Native spell checking with enable/disable preference |
| FR-050 | P1 | HTML, PDF, DOCX export with documented fidelity/fallbacks |
| FR-051 | P0 | UTF-16/UTF-8 coordinate boundary, Unicode-safe edits, revision validation |
| FR-052 | P0 | Source-preserving visual transactions and protected unknown constructs |
| FR-053 | P0 | Inline source draft: Revert (undoable), Cancel (discard+close), Apply (commit+close) |
| FR-054 | P0 | Cross-window close and inline-draft resolution state machine |
| FR-055 | P1 | Workspace-wide document search |

## 7. UX specification

### 7.1 Information architecture

```text
┌───────────────────────────────────────────────────────────────────────┐
│ Native menu bar / window chrome                                      │
├──────────────────┬────────────────────────────────────────────────────┤
│ Sidebar          │ Tabs: doc-a.md ● | doc-b.md | ...                 │
│ [Files] [TOC]    ├────────────────────────────────────────────────────┤
│                  │ Toolbar: [Read] [Source] [Split] [Visual] ...     │
│ Resize handle →  ├────────────────────────────────────────────────────┤
│                  │ Document surface (mode-specific)                   │
│ Files: tree      │  Read: rendered, readonly                         │
│ TOC: H1–H6 tree  │  Source: CodeMirror                                │
│                  │  Split: source | draggable divider | preview      │
│ [Collapse]       │  Visual: direct editing + inline source controls  │
├──────────────────┴────────────────────────────────────────────────────┤
│ Status: filename • unsaved • cursor • words • Markdown profile       │
└───────────────────────────────────────────────────────────────────────┘
```

The **left sidebar is single, collapsible, and width-resizable**, with **Files** and **Table of Contents** tabs (not two independent sidebars). TOC is available in all four modes, follows heading hierarchy H1–H6, highlights the active section, and navigates to exact heading anchors when possible. Sidebar visibility, width, and selected tab persist across application restarts, subject to usable minimum editor width. Multiple native windows and multiple tabs per window are supported. In Split mode, the source/preview divider is independently resizable. All modes are available by four persistent toolbar buttons and keyboard shortcuts. New documents open in the configured default mode, initially **Visual**.

### 7.2 User journeys

1. **Read a file:** Open file → Read mode → TOC navigation → click internal links → optionally toggle source.
2. **Edit and preview:** Open file → Split → edit text → preview updates → Save → verify disk update.
3. **Add image:** Paste image → asset path generated → relative link inserted → preview renders → save preserves asset.
4. **Handle external change:** Open and edit file → external tool modifies disk → warning appears → choose reload/keep and save copy/compare; never overwrite without acknowledgment.
5. **Recover crash:** Edit unsaved document → process terminated → reopen → recovery prompt → restore draft or discard.
6. **Review technical doc:** Outline navigation → diagram rendering → copy code → validate links → export PDF.

### 7.3 Accessibility

Full keyboard navigation, visible focus states, screen-reader labels, heading structure for rendered content, zoom, system reduced-motion and high-contrast preferences; keyboard access to tab selection, view modes, outline, links, and dialogs. Avoid relying on color alone for diagnostics.

## 8. Technical architecture

### 8.1 Stack decision record

**ADR-001: Tauri 2 + Rust + React/TypeScript.** Chosen for OS-webview footprint, native file integration, cross-platform packaging, and a clear frontend/backend security boundary. Tradeoff: webview differences require real-device QA on macOS/Windows/Linux. Alternatives: Electron (more uniform Chromium renderer, larger distribution), native SwiftUI (excellent macOS integration, poorer cross-platform reuse), Rust egui (native Rust stack but significantly more work for rich HTML/Markdown preview).

**ADR-002: CodeMirror 6 for Source and inline source editing.** Visual mode needs an independently evaluated structured editing adapter (ProseMirror/Tiptap/Milkdown or equivalent), with source-range mapping and localized Markdown patches. Do not select a visual engine solely on rendering quality: lossless unrelated-source preservation is a gating acceptance test.

**ADR-003: unified/remark/rehype pipeline.** The renderer must tokenize GFM, generate a safe AST/DOM, support extensions, and provide source-position mappings for scroll/outline sync. `react-markdown` is an acceptable component-layer implementation; ensure sanitizer and custom components do not bypass the URL policy.

**ADR-004: Filesystem is source of truth.** No SQLite document database. Store settings, recent file paths, and recovery state in app data only. Do not index repository content until a measured need.

**ADR-005: Least-privilege Tauri capabilities.** All system file reads/writes pass scoped Rust commands. The frontend must not receive unrestricted filesystem access.

### 8.2 Logical components

```
Tauri Desktop Shell
 ├── Rust Core
 │    ├── DocumentService (read, atomic save, snapshots, conflict detection)
 │    ├── WorkspaceService (scoped paths, file watcher, directory list)
 │    ├── AssetService (clipboard/import, MIME validation, safe paths)
 │    ├── ExportService (PDF/HTML, asset inclusion)
 │    └── SettingsService (schema/versioning)
 └── Web UI (React + TypeScript)
      ├── App shell / tabs / panels / command palette
      ├── Document state store + commands
      ├── CodeMirror editor adapter
      ├── Markdown parse/render service
      │    ├── GFM / footnotes / syntax highlighting
      │    ├── Mermaid adapter (isolated, strict)
      │    └── KaTeX adapter
      ├── Outline + local link resolver
      └── Read / Source / Split presentation
```

Separate **document state** from **view state**. Document content is one authoritative text buffer per open tab; read preview derives from that buffer. Keep parse diagnostics distinct from edit errors, and keep file I/O out of UI components. Use explicit interfaces for renderer, storage, and exports; mock in tests. Avoid speculative plugin abstractions.

### 8.3 Suggested TypeScript domain contracts

```ts
export type ViewMode = 'read' | 'source' | 'split';

export interface DocumentSnapshot {
  id: string;
  path: string | null;
  content: string;
  savedContentHash: string | null;
  diskRevision: string | null;
  dirty: boolean;
  encoding: 'utf-8' | 'utf-8-bom';
  newline: 'lf' | 'crlf' | 'cr';
}

export interface DiskRevision {
  modifiedAtNs: string;
  sizeBytes: number;
  contentHash: string;
}

export interface SaveRequest {
  documentId: string;
  expectedDiskRevision: DiskRevision | null;
  content: string;
  destination: string;
}

export type SaveResult =
  | { ok: true; revision: DiskRevision }
  | { ok: false; reason: 'conflict' | 'permission' | 'not-found' | 'io-error'; message: string };
```

Prefer an application-level command/result API over a giant global state object. Hashes should be computed for conflict-sensitive saves; timestamps alone are insufficient. An expected revision must be checked immediately before commit, with any overwrite conflict requiring explicit user consent.

### 8.4 File lifecycle and durability

- Read original as bytes; validate encoding and enforce configurable file-size safety limit; retain source metadata.
- Build editor buffer; do **not** normalize on load.
- Editing updates in-memory state, a debounced recovery snapshot, and a derived render tree.
- Save creates a temporary file in the destination directory, flushes it, preserves file permissions where supported, and atomically renames where OS semantics permit. Perform a final revision check; account for race conditions and document platform-specific guarantees. Never claim cross-filesystem atomicity.
- Persist recovery drafts separately, with explicit cleanup and bounded storage quota.
- Filesystem watcher correlates on-disk changes with own saves and de-duplicates events; conflict UI appears for other changes.
- Symlinks and `..` traversal require canonicalization and explicit scope decisions, not a naive `startsWith` string check.
- Image imports write unique filenames and roll back incomplete imports when feasible.

### 8.5 Rendering and security

- Disable arbitrary HTML and script execution; sanitize generated output and dangerous URL protocols (`javascript:`, untrusted `data:`, etc.).
- Default remote image fetching is **off**, or require an explicit per-document/user preference with privacy disclosure. Remote image URLs can reveal that a file was opened.
- Restrict local media access by file scope; do not expose arbitrary local files through a broad custom protocol.
- Mermaid must remain in `strict` security, with controlled configuration, content size and render-time budgets; guard against denial-of-service diagrams. Keep dependencies patched; security advisories have documented Mermaid injection and denial-of-service issues in 2026.
- No runtime MDX, iframe embeds, `<script>`, remote CSS, or plugin code.
- CSP should deny unnecessary network connections and script sources; filesystem permission scopes must be minimal. Audit Tauri custom commands rather than assuming capabilities protect unsafe Rust code.
- Exported HTML inherits preview sanitizer decisions and safe asset embedding rules.

### 8.6 Performance design

- Defer Mermaid/KaTeX parsing and heavy syntax highlighting until content is visible or idle where possible.
- Debounce render updates (nominal 100–250 ms, to be validated) and cancel stale results by document revision.
- Preserve typing responsiveness independently of preview throughput.
- Implement source-position keyed preview blocks for navigation and scroll sync, falling back to nearest heading when exact mapping unavailable.
- Never concatenate expensive reparses on each keystroke without profiling; support worker-based parsing if latency measurements require it.
- Limit memory by caching only active/recent render trees; virtualization and partial rendering can be a v1.x optimization.

## 9. Nonfunctional requirements and SLO targets

These are **initial design targets, not measured results**. Validate on an explicitly documented baseline Mac and on target Windows/Linux hosts.

| ID | Target | Measurement |
|---|---|---|
| NFR-001 | Cold launch to usable window ≤ 2 s (p95) | 30 runs, release build, representative macOS hardware |
| NFR-002 | Open & render 1 MB Markdown ≤ 1.5 s (p95), excluding unusually expensive diagrams | 30 runs, warm/cold noted separately |
| NFR-003 | 95th-percentile editor input handling ≤ 16 ms on 1 MB document | Automated keystroke profiling, with preview active |
| NFR-004 | No data loss under process crash, disk-full, interrupted write and external edit | Fault-injection integration tests |
| NFR-005 | 100% of unsupported Markdown constructs retained verbatim in saved source | Fixture round-trip tests |
| NFR-006 | Offline core functionality | Network disabled end-to-end suite |
| NFR-007 | Keyboard operation for all core workflows | Accessibility QA checklist |
| NFR-008 | No telemetry by default | Network capture and release verification |
| NFR-009 | All external document paths scoped and validated | Negative security tests |
| NFR-010 | Release builds on macOS Apple Silicon; Windows/Linux after gates | Clean CI build + signing/notarization where applicable |

Memory targets should be set only after profiling a representative workload; avoid inventing a RAM ceiling before selecting and measuring renderer dependencies.

## 10. Testing strategy

### 10.1 Test layers

**Unit:** commands, selection transformations, links, slug generation, path safety, BOM/newline handling, settings migration, save conflict rules.  
**Renderer golden tests:** CommonMark/GFM reference fixtures; frontmatter, math, Mermaid, malformed input, Unicode, nested tables/lists, duplicate headings and relative paths.  
**Rust integration:** temp files, filesystem watch, stale revisions, symlinks, permission denials, disk full, rename failures, recoverable snapshots.  
**E2E desktop:** open/edit/preview/save/restart, multiple tabs, shortcuts, external editor, asset insertion, PDFs, accessibility.  
**Security:** XSS payloads, malicious URLs, oversized images, path traversal, malicious TextPack archives, Mermaid resource exhaustion, remote tracking pixels.  
**Performance:** consistent cold/warm profiles on 100 KB, 1 MB, 5 MB and diagram-heavy fixtures; set separate large-document degradation policy.

### 10.2 Required acceptance scenarios

- Byte-identical save when file is unmodified, including CRLF, BOM, final newline and whitespace.
- Edited file retains newline style and preserves unaffected source.
- External edit cannot be silently overwritten by stale tab.
- Crash before Save restores unsaved draft without changing original.
- Broken Mermaid displays a meaningful failure and retains source.
- Markdown with script or `javascript:` link never executes code.
- Missing local image displays an accessible placeholder; no crash.
- A relative image in an adjacent asset folder renders correctly.
- Offline mode: no hidden network requests, including remote embedded images unless specifically authorized.
- Keyboard-only user can create, modify, save, find, change views and navigate outline.
- PDF/HTML/DOCX exports preserve expected headings, tables, code, images, math, and supported diagrams.

## 11. Milestones and deliverables

### M0 — Architecture decisions, scope, fixtures and ADRs

Deliver: final product scope, representative Markdown corpus, UX wireframes, threat model, initial benchmarks, ADR-001–005, **multi-window shared document registry**, **cross-mode undo plan**, **inline draft/close state machine**, **DOCX export feasibility**, release matrix, licensing/dependency audit. **Gate:** acceptance fixtures and explicit non-goals approved.

### M1 — Scaffold + document durability

Deliver: Tauri/Rust/React/TS project, menus/tabs/**multiple windows**, new/open/save/save-as, revision-safe save, recovery draft, external-change warnings, tests, CI. **Gate:** crash/conflict/round-trip tests pass before adding renderer features.

### M2 — Reader + core renderer

Deliver: CommonMark/GFM, read mode, image/link resolution, code highlighting, safe HTML handling, outline, theme and typography. **Gate:** compatibility/security fixtures pass; reader usable offline.

### M3 — Editor and split workflow

Deliver: CodeMirror, toolbar/keyboard shortcuts, source and split modes, four-mode controls, live preview, search, undo/redo, tab state. **Gate:** typing latency and mode-transition tests pass.

### M3V — Visual editing fidelity prototype (mandatory before full Visual implementation)

Deliver: representative source-range mapping, localized changes, protected unknown constructs, cross-mode undo continuity, table and Mermaid inline draft lifecycle proof. **Gate:** switch-without-edit is byte-for-byte stable, edited elements do not rewrite unrelated source, and transition/draft tests pass. If this fails, stop and document an alternative architecture rather than silently degrading the requirements.

### M4 — Technical document features

Deliver: complete Visual mode for supported blocks, Mermaid/math inline editors, editable tables, protected unknown constructs, frontmatter, scroll sync, folder tree, path checks, link validation, image paste. **Gate:** malicious-input tests and full technical-document corpus pass.

### M5 — Export, polish, release

Deliver: HTML/PDF/DOCX export, native spell check with enable/disable preference, settings, accessibility, signed macOS distribution, user-facing docs, end-to-end regression and benchmarks. **Gate:** release candidate meets P0/P1 tests and documented NFR measurements.

### M6 — Windows/Linux portability (may overlap M4/M5)

Deliver: verified installers and file-association behavior per platform; system webview differences and export behavior tested. **Gate:** clean builds and full smoke suite on each platform; no unsupported parity claims.

**Recommended build sequence:** M0 → M1 → M2 → M3 → **M3V (mandatory gate)** → M4 → M5; pursue M6 opportunistically without destabilizing macOS-first release.

## 12. Epics and backlog

| Epic | User stories | Dependency | Milestone |
|---|---|---|---|
| E1 Shell and app foundation | App window, tabs, menus, preferences, CI | None | M1 |
| E2 Safe document storage | Open/save, metadata preservation, revision conflicts, recovery | E1 | M1 |
| E3 Rendering | GFM, HTML safety, links, highlighting, outline | E1 | M2 |
| E4 Editing | CodeMirror, commands, split preview, find/replace | E2, E3 | M3 |
| E5 Advanced Markdown | Mermaid, math, image paste, frontmatter, tables | E3, E4 | M4 |
| E6 Workspace operations | Folder browser, file watcher, link validation | E2 | M4 |
| E7 Export and packaging | HTML/PDF/DOCX, installation, documentation | E3–E6 | M5 |
| E8 Quality/security/performance | Tests, fuzzing, benchmarks, accessibility | All, continuous | M1–M6 |
| E9 Multi-platform validation | Windows/Linux filesystem and UI behavior | E1–E8 | M6 |

Each story must include user-visible acceptance criteria, automated test coverage, performance/security implications, and traceability to FR/NFR IDs. Do not count architecture scaffolding as feature completion.

## 13. Risks and mitigations

| Risk | Likelihood/impact | Mitigation |
|---|---|---|
| Save conflicts/data loss | Medium / Critical | M1-first durability design; revision checks, recovery, fault injection |
| Visual editing source loss | High / High | Source-preserving localized edits; protected fallbacks; mandatory M3V fidelity gate |
| Renderer XSS / Mermaid abuse | Medium / Critical | Sanitization, strict Mermaid, CSP, sandbox considerations, security tests and updates |
| Webview parity differences | Medium / Medium | Platform-specific E2E and pinned supported OS versions |
| Parser performance on large docs | Medium / Medium | Fixtures, tracing, cancel stale render, lazy highlighting |
| Relative path/image breakage | Medium / High | Central path resolver and integration fixtures |
| Export differences vs GitHub | High / Medium | Document dialect profiles and golden outputs |
| Scope expansion into Obsidian clone | High / High | Enforce explicit non-goals and milestones |
| Packaging/signing friction | Medium / Medium | Establish CI/release pipeline in M1 |
| Third-party license/incompatibility | Medium / Medium | Dependency inventory and licenses prior to release |

## 14. Success measures

**Engineering:** zero known critical document-loss defects; no known high-severity renderer vulnerabilities at release; 100% critical regression pass; target NFR performance confirmed on published test matrix.  
**UX:** successful first-file-open and read without setup; edit/save round trip succeeds in usability test; users can switch modes and navigate outline without instructions.  
**Product:** target users prefer this experience for single-document reading and review over their existing IDE preview; evaluate through structured pilot rather than invented adoption numbers.

## 15. Decisions still to validate

These are not blockers to M0/M1, but should be resolved through short spikes:

1. **Remote media:** default off with explicit enablement; decide per-document vs global persistence.
2. **PDF engine:** compare native webview print/PDF vs headless engine for parity and portability.
3. **HTML handling:** completely escape raw HTML in v1 vs sanitizing a restricted subset; prefer escape by default.
4. **Workspace scope:** open only selected files vs whole directory permission; least privilege.
5. **TextBundle:** move to P1 if actual One Markdown interoperability proves essential for target users.
6. **License and branding:** decide before distribution; audit commercial compatibility of all dependencies and fonts.

## 16. Suggested repository structure

```
markdown-desktop/
├── README.md
├── LICENSE (when chosen)
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── app/                # composition, routes, tabs, commands
│   ├── components/         # reusable presentation
│   ├── features/
│   │   ├── documents/      # document state, save workflow
│   │   ├── editor/         # CodeMirror adapter and commands
│   │   ├── preview/        # renderer and link policy
│   │   ├── outline/        # headings and navigation
│   │   ├── workspace/      # files, tree, watchers
│   │   └── export/         # HTML/PDF UI
│   ├── services/           # typed Tauri command facade
│   ├── styles/             # themes and print styles
│   └── tests/              # unit and fixture tests
├── src-tauri/
│   ├── src/
│   │   ├── documents/      # IO, atomic saves, recovery
│   │   ├── workspace/      # scoped filesystem access
│   │   ├── assets/         # safe import and resolution
│   │   ├── export/         # print/export integration
│   │   └── settings/       # settings schema and persistence
│   └── capabilities/       # least-privilege manifests
├── fixtures/
│   ├── markdown/
│   ├── hostile-input/
│   └── filesystem/
├── docs/
│   ├── prd.md
│   ├── architecture.md
│   ├── threat-model.md
│   ├── adr/
│   └── test-plan.md
└── .github/workflows/
```

`.gitignore` must include both Node and Python artifacts, e.g. `node_modules/`, `dist/`, `target/`, `.venv/`, `__pycache__/`, `*.pyc`, `.pytest_cache/`, `.env`, plus OS-specific ephemeral files. Keep tests co-located where practical and centralize fixture documents. This is a **proposed** layout, not an existing scaffold.

## 17. Implementation handoff instructions for Codex

1. Review this PRD and produce a requirement-to-task map, explicitly identifying unmet dependencies or security issues.
2. Implement **M0 and M1 only** initially, including real automated file-durability and conflict tests; do not begin advanced rendering or full Visual mode before the M3V validation gate.
3. Pin dependencies, specify supported OS/runtime versions, and document decisions in ADRs.
4. Keep domain logic independent from React. Implement file I/O behind typed Rust commands with least-privilege access.
5. Verify source preservation, recovery, and safe writes before feature expansion.
6. No network calls, analytics, cloud integrations, or AI features in the app without an explicit subsequent requirement.
7. Each milestone concludes with commands executed, test results, known gaps, and a requirement traceability report.

## 18. Source bibliography

**Primary product/feature references:**

- One Markdown App Store: https://apps.apple.com/us/app/one-markdown/id1507139439
- VS Code Markdown docs: https://code.visualstudio.com/docs/languages/markdown
- MarkText official GitHub: https://github.com/marktext/marktext
- Zettlr feature list: https://www.zettlr.com/features
- Markdown app directory: https://markdown.org/apps/

**Standards and engineering references:**

- CommonMark specification: https://spec.commonmark.org/
- GitHub Flavored Markdown: https://github.github.com/gfm/
- TextBundle specification: https://textbundle.org/spec/
- Tauri architecture: https://tauri.app/concept/architecture/
- Tauri security capabilities: https://tauri.app/security/capabilities/
- react-markdown / security: https://github.com/remarkjs/react-markdown
- Mermaid security configuration: https://github.com/mermaid-js/mermaid/blob/develop/docs/config/usage.md
- Mermaid security advisories: https://github.com/mermaid-js/mermaid/security/advisories

**Secondary landscape comparisons, not authoritative for product-specific behavior:**

- https://www.itechguides.com/best-markdown-editors-for-beginners-developers-and-writers-compared/
- https://notula.org/best-markdown-editors/

---

**Disposition:** This PRD is actionable for architecture validation and MVP implementation. It does not claim that the product is implemented, that competitors were performance-tested, or that unverified feature parity exists.
