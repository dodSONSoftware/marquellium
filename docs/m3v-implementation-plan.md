# M3V implementation plan

- Date: October 30, 2026 (America/Chicago)
- Baseline: `4884782450a8afe90ac9df51be4f9d150cc216da` (`initial commit`), version 0.1.0.
- Status: Proposed implementation plan. No M3V implementation is authorized by this document.
- Purpose: Prove that the ADR-002 block-mapped architecture can edit representative rendered content without compromising canonical Markdown, history, draft isolation, or multi-window safety. Passing this gate is required before full Visual mode in M4.

## 1. Governing requirements

The binding scope is [PRD sections 1A and 1B, and M3V](prd.md), especially all eight tests in section 1A.5, AT-102–108, AT-110–112, AT-116–117, and FR-051–054. Supporting decisions are [ADR-002](adr/0002-editing-engines.md), [ADR-003](adr/0003-rendering-pipeline.md), [ADR-004](adr/0004-filesystem-source-of-truth.md), [ADR-006](adr/0006-multi-window-document-registry.md), [ADR-007](adr/0007-cross-mode-shared-undo.md), [ADR-008](adr/0008-inline-draft-and-close-state-machine.md), and [ADR-010](adr/0010-coordinates-and-encoding.md).

**Gate:** switch-without-edit is byte-for-byte stable, edited elements do not rewrite unrelated source, and transition/draft tests pass. **Failure ⇒ stop, document alternatives, do not relax.** A failed architecture gate must not be relabeled as a successful limited release.

This plan is a development plan, not a cumulative workshop checkpoint. It does not amend the PRD, ADRs, requirement map, or acceptance status.

## 2. Baseline facts and gaps

| Inspected code | Reuse and required change |
| --- | --- |
| `src/core/positions.ts`, `ops.ts`, `text-diff.ts` | Reuse `ByteIndex`, byte-op validation, and surrogate-safe diffing. Current interfaces use plain numeric offsets; add explicit typed ranges at the new mapping boundary rather than assume the ADR's branded types already exist. |
| `src/core/render/pipeline.ts` | Reader has GFM/math/frontmatter parsing and safety transforms. `createMdast` currently uses only remark-parse; its minimal `MNode` type does not retain typed start/end offsets. Add a raw source-mapping parse path with the correct dialect before frontmatter stripping or rendering transforms. |
| `src/features/documents/DocumentStore.ts` | Rust remains canonical; frontend mirrors reconcile revisions and serialize edit groups. There is no public, range-checked visual transaction entry. Add one that awaits outstanding edits, validates its captured revision/range, submits once, and propagates rejection. Never use whole-buffer recovery replacement as the visual editing API. |
| `src/features/editor/SourceEditor.tsx` | Reuse CodeMirror conventions and shared document history bindings. Draft editors need separate CM state and local history, with canonical edit listeners detached. |
| `src-tauri/src/documents/registry.rs` | Transactions, shared history, and view lifetime exist. `set_draft_active` blindly replaces a token; it does not atomically acquire a session, identify its owning window, or validate ownership on release/Apply. |
| `src-tauri/src/lib.rs`, `documents/recovery.rs` | Recovery accepts optional draft text, but snapshot creation returns early for a clean canonical document. A modified draft over a clean document is therefore not covered. Text alone is also insufficient to safely reconstruct a source-bound session. |
| `src/core/close-state-machine.ts`, `src/app/App.tsx` | Pure draft/canonical resolution logic exists, but App supplies `draft: "absent"`. Mode switching is not wired to draft resolution. Current app quit requests each window's closure independently; this is not ADR-008's per-document, all-windows resolution-before-destruction contract. |
| `src/app/App.tsx`, `src/services/native.ts` | Visual is unavailable. Reuse four-mode shell, native event routing, listener cleanup, and per-tab state. New lifecycle work must retain the existing menu, close, and synchronization regressions. |

The preceding work reported 209 passing frontend tests, 43 Rust tests, clean TypeScript/Clippy checks, and a successful macOS app build. Native typing, Undo/Redo synchronization, and surface close/quit checks were user-observed; exhaustive lifecycle acceptance remains pending. Those results were not rerun to prepare this plan and do not establish M3V readiness.

## 3. Bounded prototype scope

Use the actual proposed production transaction and draft paths, not a separate demonstration buffer.

| Surface | Prototype capability | Conservative boundary |
| --- | --- | --- |
| Paragraph and heading | Direct editing of plain text and a mapped plain-text leaf adjacent to emphasis or links; retain surrounding syntax. | Rich inline restructuring, arbitrary cross-block selections, and ambiguous nesting use protected source editing. Do not normalize a whole paragraph merely to change one word. |
| GFM table | Direct text edit of an existing cell, then inline Markdown draft editing, Apply, and continued direct cell editing. | Prove escaped pipes, code spans, alignment markers, cell spacing, and row boundaries. Unsupported table shapes are protected. Row/column insertion helpers and full keyboard navigation remain M4. |
| Mermaid fence | Inline source draft with real syntax validation and live diagram preview, then a localized Apply. | Preserve fence marker/length, info string, surrounding trivia, and body line endings. Invalid syntax keeps the last valid preview. No fake validator or source-only preview can satisfy this proof. |
| Unsupported or ambiguous content | Visibly protected blocks with explicit source-draft editing. | Raw HTML, directives, wikilinks, callouts, embeds, and mixed unsupported syntax never become editable through an unaware serializer. Plain text AST nodes are not automatically safe to regenerate. |
| Lists, blockquotes, code, math, frontmatter | Lossless source mapping and protected/read-only representation in the prototype. | Complete direct list/blockquote editing and specialized math/code editors remain M4. Preserve all bytes during mode switches and neighboring edits. |
| Mode and selection | Four-mode transitions using source/block anchors; no write on view changes. | Preserve exact selection where valid; otherwise navigate to a safe nearby context. Navigation fallback never authorizes rounding edit boundaries. |

The prototype is opt-in for development/native acceptance. Keep Source as the normal opening fallback while the gate is pending. The requirement map tracks the Visual default as a gate exit item: explicitly review that setting after acceptance, without presenting a representative prototype as complete M4 Visual mode.

Out of scope: full WYSIWYG editing, an alternative editing engine implementation, workspace expansion, image paste, exports, preference redesign, distribution signing, and Windows/Linux acceptance. No dependency upgrades or unrelated refactors are planned. Installed Mermaid capabilities must first be evaluated against the existing threat model; a new dependency requires demonstrated need.

## 4. Implementation sequence and review points

### A. Establish the integrity harness and source mapping

1. Inventory existing corpus properties and define fixture operations with checked-in expected byte outputs and authorized edit ranges.
2. Parse canonical, BOM-stripped text using the reader's dialect configuration, retaining untransformed node offsets. Confirm offset units empirically with emoji and CRLF fixtures; do not infer UTF-8 positions from remark offsets.
3. Introduce revision-bound, explicitly typed source ranges and mapped blocks/text leaves. Retain original source slices and gaps, blank lines, comments, delimiters, and other trivia. Every byte must remain represented, including protected regions.
4. Rebuild the derived map after acknowledged canonical changes. DOM positions and array indices are not persistent identities. Reject stale maps rather than reuse shifted ranges.
5. Define safe navigation anchors for mode changes separately from editable ranges.

Proposed files: `src/core/source-map.ts` and tests, with narrowly shared parser configuration in `src/core/render/pipeline.ts`. Keep readers' escaped HTML and URL policy unchanged.

**Review point:** mapping and classification are independently tested before any editable surface is enabled.

### B. Add localized canonical transactions

1. Add a DocumentStore entry for explicit localized edits with document ID, base revision, authorized range, opening text, and replacement text.
2. Flush and await pending Source commits before acquiring a map/draft snapshot. Recheck all assumptions after awaiting; flushing may advance the revision.
3. Validate the current revision and source slice, ensure the proposed edit is inside the authorized construct, and convert UTF-16 ranges through `ByteIndex` once at the wire boundary.
4. Use the smallest valid replacement range. A text edit preserves inline markers; structural table source edits may replace the authorized table, never adjacent blocks. A no-op submits nothing.
5. Submit one revision-checked transaction. Multiple ops, where required, use ascending, non-overlapping pre-batch coordinates. No per-keystroke coordinate concatenation, automatic full-buffer fallback, or silent rejection.

Proposed files: `src/core/localized-edit.ts`, limited construct-specific edit helpers, and `src/features/documents/DocumentStore.ts`. The registry remains the mutation authority.

**Review point:** exact byte outputs and failure atomicity pass before UI integration.

### C. Enforce draft ownership and isolated history

1. Add atomic registry session acquire/release with document ID, owner window, unique token, base revision, and range identity. Reject competing acquisition; only the owner/token can update, Apply, or release. Failed acquisition changes nothing.
2. Keep draft text and CM history separate from canonical content. Capture immutable opening text, range, and revision. Revert is a normal local CM change, undoable inside the draft.
3. Validate drafts and render bounded previews. Apply requires validity, current revision/range, and ownership checked atomically with the canonical commit. Commit and lease release must not race in separate unchecked calls.
4. Any concurrent canonical edit makes a captured draft stale. Preserve draft text, block Apply, and offer copy/reopen or Cancel; automatic rebasing is not required for this gate. Never resubmit an old range against a new revision.
5. Clean sessions may close silently when replaced; modified sessions require owner-directed resolution. A second window must not clear another window's token to take over. Owner-window destruction/crash must release or recover the session safely.
6. Apply creates exactly one canonical history entry; unchanged Apply and Cancel create none. Session closure destroys local history. Direct table changes are rejected while its draft is active, including requests from another window.

Proposed files: `src/core/draft-session.ts`, `src/features/visual/InlineSourceEditor.tsx`, registry/command changes, and typed service contracts. Wire validation belongs in Rust as well as frontend guards.

### D. Prove previews and assemble the visual surface

1. Implement the bounded paragraph/heading and table-cell adapters, then a top-level block surface derived from source maps.
2. Reuse reader safety policies for rendered content; never turn arbitrary source or engine output into trusted HTML. Retain protected source rendering for unsupported input.
3. For Mermaid, first prove an isolated, local-only preview with strict security settings and enforceable input/time/resource limits. A timer around synchronous main-thread rendering is not a timeout. Use a discardable execution surface if necessary; reject stale preview results using session and validation generations.
4. Invalid or resource-limited previews retain the last valid preview and diagnostics. Table validation must reject edits that escape the intended block or produce an unsupported structure.
5. Inline controls remain Revert on the left and Cancel/Apply on the right. Discard exists in navigation confirmation, not as a fourth inline button.

**Review point:** all PRD section 1A.5 scenarios execute through the actual adapters, real preview validation, and registry path.

### E. Integrate navigation, shutdown, and recovery

1. Feed actual draft state into the close coordinator. Mode switch, tab switch, close, reload, and app quit must resolve or preserve the owning draft; blur never implicitly applies it.
2. Extend global quit coordination to gather unique canonical documents and remote draft owners before destroying any window. Resolve drafts first, canonical changes second; prompt a shared document once. Cancel aborts the entire quit without previously closing another window. Failed Save/Apply retains all working state.
3. Treat red-button closure as a window-scoped request, and menu/keyboard/Dock Quit as application-scoped requests. Repeated requests must not replace the active coordinator or duplicate prompts. Registration failures must remain observable.
4. Recovery must include modified drafts even when canonical content is clean. Persist enough versioned data to validate reconstruction: canonical bytes/revision identity, BOM/newline metadata, opening slice/range, draft text/type, and conflict state. Restore only by opt-in, without overwriting the original file. If the disk/base changed, reopen as a conflicted draft or safe recovered copy; do not attach blindly to the current range. Ephemeral CM history is not persisted.
5. Recheck external-edit events against both canonical dirty state and active drafts. Canonical Save must not include unapplied draft text. Recovery-only draft dirtiness must not falsely dirty the canonical document.

This is required safety integration, not an assumption that the baseline already satisfies ADR-008. If it cannot be completed coherently inside M3V, mark the gate blocked rather than quietly defer its cross-window acceptance criteria.

## 5. Fixture plan

Retain existing files and independently review expected outputs. Do not regenerate expected fixtures from the implementation under test.

| Corpus | Required use |
| --- | --- |
| `fixtures/markdown/edit-preserving/{crlf,bom,mixed,no-trailing}-{input,expected}.md` | Execute the actual localized edit described by each pair: CRLF heading rename; BOM paragraph edit; mixed-ending paragraph edit; final-line append without a final newline. Compare full saved bytes. Inspected CRLF/mixed files contain real CRLF bytes, not literal escape sequences. |
| `fixtures/markdown/roundtrip/*.md` | Four-mode no-edit cycles and native open/save: BOM, BOM+CRLF, CRLF, CR-only, mixed endings, trailing spaces, and no final newline. |
| `common-markdown.md`, `gfm-full.md`, `unicode.md`, `code-heavy.md`, `frontmatter.md`, `links-images.md`, `unsupported-constructs.md`, `mermaid-math.md` | Full-file no-edit stability, block classification, neighboring-edit preservation, source-anchor navigation, and protected fallbacks. |
| `fixtures/markdown/large-1mb.md` | Mapping completeness and bounded interaction/preview behavior. Record measurements; unit-test runtime is not proof of the PRD input-latency budget. |
| `fixtures/hostile-input/*` | Preserve refusal of invalid encoding; apply existing URL/HTML/path protections; verify parser/preview limits for deep nesting, oversized content, and Mermaid bombs. |

Add `fixtures/markdown/m3v/` with an explicit case manifest: input, operation/selection, authorized range or anchored construct, expected output, expected protected classification, expected transaction count, and required negative outcomes. Required cases:

- Paragraph/heading plain text surrounded by emphasis, links, comments, and directives; repeated identical paragraphs to catch identity-by-text mistakes.
- GFM cells with escaped pipes, inline code containing pipes, unequal spacing, alignment markers, empty cells, and invalid delimiter rows.
- Mermaid fences using backticks and tildes, longer fences, info-string variations, CRLF bodies, invalid syntax, and valid input followed by invalid input.
- Unsupported syntax mixed into otherwise ordinary paragraphs/list/quote blocks; unknown content before and after an editable block.
- Unicode before and inside target ranges: emoji, ZWJ sequences, combining marks, CJK, Unicode filenames, and deliberate surrogate-splitting/unsafe selections.
- Duplicate headings, blank-line gaps, multiple adjacent edits, and multi-op length changes affecting later offsets.
- Stale draft after an edit before, inside, or after its range; lease acquisition races; wrong-owner release/Apply; owner destruction; delayed/duplicate/out-of-order events and previews.
- Modified draft over a clean canonical file, modified draft over an already dirty file, and untitled canonical content for recovery/quit tests.

## 6. Tests and pass or fail criteria

| Gate | Required assertions | Evidence |
| --- | --- | --- |
| G1 No-edit stability — section 1A.5.1, AT-102/103 | All corpus files survive Read→Source→Split→Visual→Source and reverse cycles with identical canonical/saved bytes, metadata, dirty state, and history position. Modes submit zero transactions. Exact safe selections survive; unsafe navigation has documented safe fallback. | Core plus adapter/component tests; Rust file-byte tests; packaged native spot checks. |
| G2 Localized edits — section 1A.5.2/8, FR-052 | Paragraph/heading, table cell, and Mermaid Apply match independently authored expected bytes. Untouched prefix/suffix and protected neighbors remain exact, including delimiters, BOM, whitespace, line endings, and EOF. Submitted ranges stay within authorization. | Fixture tests through real edit helpers and registry; saved-byte integration. |
| G3 Shared history — section 1A.5.3/7, AT-103/104/110 | Source burst→mode switches→visual edit→draft Apply→Undo/Redo forms the expected single document history. Apply is one entry; no-op/Cancel/open/preview are zero. Two mirrors immediately receive the inverse/redo at increasing revisions without further typing. | Store integration with delayed IPC; Rust wire-event replay including multi-op Unicode edits; two native windows. |
| G4 Draft lifecycle — section 1A.5.3–7, AT-110/111/112 | Valid preview does not mutate canonical state. Revert stays open and is locally undoable. Invalid draft disables Apply and preserves last valid preview. Cancel/unchanged Apply leave canonical bytes, dirty state, and history unchanged. Closed session history cannot leak into a new session. Direct table edits resume after Apply. | Actual CM state/history tests and component-level controls tests, then native interaction. |
| G5 Transactions and ownership — FR-051/054, AT-116/117 | Stale revision/map/token/range, invalid UTF-8 boundary, unsafe selection, malformed ops, and competing sessions reject without partial content/history/ownership mutation. One winner for concurrent session acquisition. Later events cannot resurrect an old session or double-apply a transaction. | TypeScript boundary and store tests; Rust command/service tests; interleaved two-client tests. |
| G6 Exit safety — AT-105–108, section 1A.5.6 | Every exit resolves drafts before canonical changes. Invalid/stale Apply or failed Save leaves prompt/data open. Cancel quit preserves every window/document. Shared documents prompt once; one view closing preserves surviving data. Repeated requests, no-focused-window Quit, native menu/keyboard/Dock/red-button paths, and late listener cleanup are covered. | Coordinator integration and command tests; repeated packaged-app two-window native checklist. |
| G7 Recovery and safety | Modified drafts survive restart even with a clean canonical document; restore is opt-in and disk remains untouched. Conflicting bases cannot receive blind Apply. Unsafe HTML/URLs and engine resource limits remain enforced; delayed validation cannot replace a newer preview. | Recovery fixtures and filesystem tests; isolated preview tests; deliberate packaged-app interruption with disposable files. |

A text or HTML snapshot alone does not establish byte fidelity. Assert raw byte arrays, original BOM metadata, and exact saved-file bytes. Test oracles must not call the serializer to construct their expected result. A test with the registry/renderer mocked cannot establish the corresponding native integration claim.

Component-level tests must exercise actual CM draft history and lifecycle effects, not merely the pure coordinator. The current Vitest setup has no DOM/component harness; select the smallest suitable harness during implementation and justify any added development dependency. Keep Rust command tests and frontend facade tests aligned so mocks cannot substitute incorrect Undo/Redo payloads or hide event-target mismatches.

## 7. Validation and acceptance procedure

Before implementation, inspect Git status and preserve unrelated work. Work against the committed baseline; make focused, reviewable changes by work package. Do not commit or change branches without authorization.

At each work package run the focused new tests and relevant existing regression tests. At the final gate run:

```sh
pnpm test
pnpm typecheck
pnpm build:web
cargo test --manifest-path src-tauri/Cargo.toml --offline
cargo clippy --manifest-path src-tauri/Cargo.toml --offline --all-targets -- -D warnings
pnpm tauri build --bundles app
```

Use existing format conventions and check the final diff. Record exact command results, source revision/working-tree state, OS/architecture, fixture inventory, and limitations. An unavailable dependency, blocked UI-control tool, or failed DMG packaging is not evidence that a behavioral gate passed or failed. Resolve the blocker or mark that gate unverified. Do not require a DMG to test the built `.app`; installer acceptance remains separate.

Native macOS acceptance must start with one identified build/process, disposable fixtures, and two windows within that process. Exercise all eight section 1A.5 cases, then repeat Cancel→retry→Save/Discard sequences, immediate close after typing, same-file and different-file quit, and external edits during a draft. Capture exact actions and results. Do not infer native success from unit tests or from a successful app launch.

**Pass requires all G1–G7 assertions, all eight PRD scenarios, passing existing regressions, and recorded native acceptance.** No unexplained fixture exclusions, skipped mandatory cases, weakened expected outputs, or source normalization allowances. Performance measurements must identify their environment; comprehensive release benchmarks remain M5, while any prototype stall/resource failure must be resolved before claiming the architecture viable.

**Stop conditions:** unrelated byte changes; an unsafe/stale Apply accepted; draft text silently committed/discarded; split canonical histories; lost recovery data; resource limits that cannot be enforced; or inability to satisfy the required navigation/editing scope. First correct ordinary defects and rerun the affected gate. If the architecture cannot meet the invariant, stop M3V, retain failing fixtures and evidence, and document measured alternatives under ADR-002 for user review. Full Visual mode does not start on a partial pass.

## 8. Decisions to resolve at implementation review

1. **PRD versus ADR-010 selection safety:** the PRD requires rejection of unsafe grapheme selections; ADR-010 permits boundaries within ZWJ/combining sequences while protecting code points. Follow the stricter PRD for new visual edits and explicitly reconcile the ADR before implementation; do not introduce global Source behavior changes implicitly.
2. **Cross-window quit:** the current independent window-close flow is a known implementation/design gap, despite passing surface checks. The gate requires application-wide resolution before destruction, not sequentially closing some windows before a later Cancel.
3. **Draft validation and isolation:** choose the actual Mermaid execution boundary and demonstrate enforceable cancellation/budgets before claiming live-preview proof. A security limitation is a gate blocker, not permission to replace the proof with a placeholder.
4. **Supported edit capability:** approve the bounded direct-edit set above. A construct is protected only through a visible capability decision; silently protecting every required representative edit cannot pass M3V.
5. **Gate exit:** review evidence and user acceptance explicitly, reconcile ADR/requirement-map descriptions with the final implementation, and decide the Visual default separately. Plan approval authorizes neither implementation nor acceptance.

## 9. Planned deliverables

- Revision-bound mapping and localized edit helpers with byte-level fixtures/tests.
- Small, opt-in visual block surface covering the required representative direct edits and real table/Mermaid drafts.
- Atomic cross-window draft ownership, lifecycle/quit integration, and draft recovery.
- Automated and native acceptance record listing each G1–G7 result, all PRD section 1A.5 cases, remaining limitations, and the explicit pass/stop decision.
- If the gate fails architecturally, a documented alternative with preserved failing cases; no M4 implementation.

Immediate next work after separate implementation authorization: package A, the source-map and fidelity harness. No source files, fixtures, dependencies, or runtime settings are changed by creating this plan.
