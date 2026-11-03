# M3V package E results

Date: November 1, 2026 (America/Chicago). Environment: macOS, Darwin arm64.
Baseline: `dc23ba4` plus its A–D implementation commit `5b36c45`.

Package E implements navigation, coordinated close/Quit, and persistent draft recovery for the bounded M3V prototype. **The complete M3V acceptance gate subsequently passed on macOS arm64; see the final acceptance addendum below.** Automated service/component results and packaged native interactive acceptance are distinct; the latter still needs the walkthrough below. No M4 work, release-default change, dependency upgrade, commit, or push is included in this package.

## Navigation and resolution

- The opt-in build exposes the existing bounded Visual surface in the main window as well as the pinned prototype windows. Source and Reader remain mounted during mode changes. Normal builds keep Visual gated, and opening/default-mode fallback remains Source.
- Mode/tab changes, New/Open navigation away from a document, tab close, red-button window close, document reload, and application Quit enter the same native application-wide transaction. Real frontend draft sessions supply owner-side Apply/Cancel and local history; the old App shim that always supplied `draft: absent` is removed.
- Prepare requests freeze the participating views and await direct edits and canonical queues. Retained unconfirmed direct text, unfinished editor acquisition, an unresolved dialog, or a failed/missing listener causes a visible failure with surviving windows preserved. A missing preparation response times out after 15 seconds; user-resolution responses have a ten-minute deadline. No deadline discards user data or force-closes a window.
- Draft prompts run in the actual owning window. Invalid/stale Apply is blocked; failed Apply leaves the prompt and draft text open. Clean drafts need no prompt. An editor-opening request that encounters another owner uses the same resolution path. If Apply changes the caller's captured source map, opening rejects that old map and requires a fresh attempt; no automatic rebase occurs.
- Mode/tab navigation resolves drafts but preserves ordinary canonical dirtiness without a Save prompt. Destructive close/reload/Quit requests resolve canonical changes afterward. Quit gathers unique registry documents across every window; all draft steps precede all canonical steps, and a shared document is prompted once. The prompt includes the affected-document list.
- Explicit Discard decisions are deferred until there are no remaining Cancel steps. Cancel preserves all windows and still-pending draft Discard choices. Earlier explicit successful Save or Apply choices remain successful; canceling the closure does not undo those user-requested operations.
- Repeated requests cannot replace the active transaction. Replies are bound to their requested window and request ID. Request generations and release generations prevent duplicates, late replies, and old release/completion messages from clearing a newer input barrier. Native menus cannot create a new participant during resolution.
- Window/tab releases execute while the barrier is held. Closing one shared view preserves the surviving canonical document, dirty state, and history. Tab cleanup removes its frontend mirror without issuing a second native release. A late revision/window-set change rejects execution; no window is closed before resolution succeeds.
- Menu, keyboard, and Dock Quit use the application coordinator, including when no window has keyboard focus. Red-button closure remains window-scoped. The legacy confirmation command is guarded rather than being a direct destruction bypass.

## Disk events and recovery

- External-change handling rechecks current canonical dirtiness and active draft ownership. Automatic reload is clean-only, revision-pinned, and refuses an active draft. It flushes rather than drops pending Source edits. Confirmed reload resolves drafts/canonical changes, then replaces the buffer under the barrier as one undoable transaction.
- A modified acknowledged draft is persisted even over a clean canonical file. Canonical Save still writes only canonical bytes and retains unapplied-draft recovery. Apply/Cancel persist the resulting authoritative registry state, so a late timer cannot resurrect an old draft. Draft updates require persistence before acknowledgement. Recovery failures are surfaced. Once owner-side Apply/Cancel or file Save has committed, a subsequent recovery-maintenance error is a persistent warning rather than a false failure of that completed action; the last acknowledged pre-Apply draft record remains recoverable if replacement fails.
- Recovery uses a version-2 single atomic record containing canonical file bytes, revision, BOM/newline metadata, saved disk identity, draft kind/text, immutable opening range/text/revision, ownership/generation information, session identity, and conflict state. The checksum covers bytes and metadata. The temporary file is synced, renamed, and the directory synced on Unix. Records have a 64 MiB size cap; the existing 500 MiB quota accounts for serialized records, including draft metadata.
- Session-specific keys prevent a new session's Save/timer from overwriting deferred crash recovery. Current-session snapshots are excluded from recovery offers in a newly opened window. Legacy paired snapshots remain readable; malformed/unsupported/corrupt records are retained but not offered for blind restoration.
- Restore is explicit and always creates untitled recovered copies. Original files are never overwritten by restoration. With an unchanged validated base and the opt-in Visual capability, recovery installs an orphaned lease and reopens the inline editor with modified text and fresh local history. New identity/range/revision checks and a rotated ownership token are required before Apply.
- Changed/missing disk files, stale or invalid opening ranges, old unbound draft formats, and unavailable Visual capability produce separate safe Source copies of canonical and draft text. Conflicted copies remain marked in subsequent recovery records. Durable recovered records are written before the original recovery record is removed.

The application-wide barrier/transport lives in Rust; actual session actions and user prompts remain in the frontend. The earlier pure close-state utility remains tested, but it is not the production cross-window coordinator or a substitute for real session state.

## Regression evidence

| Area | Focused assertions |
| --- | --- |
| Coordinator with real registry/files | All drafts before canonical prompts; clean canonical becomes dirty after Apply; shared document deduplication; remote owner routing; later Cancel preserves all windows and staged draft text; failed Save/invalid Apply preserve work; no-focus Quit; repeated requests; late revision/window changes; close-tab/window shared-view lifetime; reload ordering and Undo. |
| Frontend lifecycle component | Actual DraftSession/CM state; invalid Apply disabled; local history/text retained on Cancel; real owner Apply; failed Apply/Save keep the prompt; Save As picker cancellation; orphan text without blind Apply; retained direct edits prevent navigation; stale release/completion/preparation cannot unfreeze a newer transaction. |
| Recovery with real filesystem | Clean canonical plus modified draft; save never writes draft text; BOM/CRLF exact bytes; fresh-process-style reconstruction and guarded Apply; changed disk/stale bases produce safe copies; conflict metadata persists; live-session filtering; new saves cannot erase deferred crash records; torn temporary files/corruption/traversal rejection; legacy recovery. |
| Existing integration | Source-map/fidelity corpus, localized transactions, direct editing, table/Mermaid drafts, isolated/shared history, saved-state synchronization, and scoped native event tests remain passing. |

## Validation

| Command | Result |
| --- | --- |
| `pnpm test` | **398 passed**, 20 test files. |
| `pnpm typecheck` | Passed. |
| `VITE_M3V_VISUAL_PROTOTYPE=0 pnpm build:web` | Passed; validates the normal gated build. |
| `cargo test --manifest-path src-tauri/Cargo.toml --offline` | **86 passed, 1 ignored**; the ignored entry remains the explicitly invoked Mermaid subprocess fixture, not a skipped package E case. |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --offline --all-targets -- -D warnings` | Passed. |
| `VITE_M3V_VISUAL_PROTOTYPE=1 pnpm tauri build --bundles app` | Passed; produces the opt-in macOS app. |
| Tracked/new-file whitespace checks | Passed. |

The existing large-chunk and ineffective Tauri dynamic-import warnings remain. No warnings or regression expectations were suppressed. The delayed-ack mirror-replacement regression now uses a non-destructive metadata refresh instead of a reload; it retains its original identity/reconciliation assertions. Reload now waits for pending edits, so using it as that test's concurrent refresh would deadlock its deliberately held acknowledgement.

Built app: `src-tauri/target/release/bundle/macos/Markdown Viewer.app`.
Backend tests use the real registry and filesystem; lifecycle window transport/destruction is a protocol double. Component tests use actual React and CM history with protocol doubles for native commands. **No package E native Quit/Cancel or deliberate process-interruption success is claimed by these automated checks.**

## Focused packaged-app acceptance still required

Use disposable files and one identified app process. Keep the package D byte/preview limits in force; this work does not establish large-document Visual performance or full M4 editing support.

1. In the opt-in main window, enter Visual, edit a table/Mermaid source draft, and attempt Read/Source mode or tab navigation. Cancel must preserve mode, draft text, and local Undo. Discard must navigate without a canonical transaction; valid Apply must create one canonical undo step. Invalid/stale Apply must remain blocked. Repeat with the draft owned by a second window.
2. Open a shared file in two windows plus a different dirty document. Trigger Quit from the menu, Command-Q, and Dock. Resolve drafts first, then canonical changes; each shared document prompts once. Cancel at a later document must leave every window open. A staged Discard must not have discarded an earlier draft. Repeat Quit during the prompt: no duplicate coordinator or premature close.
3. Cause a Save failure with a disposable deleted/changed target. Save must keep the prompt and all windows open; retry or Cancel must remain possible. Repeat red-button closure and tab closure while another view holds dirty shared content; surviving views/history must remain intact.
4. Modify a draft over a clean saved file, wait for validation/synchronization, and deliberately terminate only the disposable test app process. Relaunch and opt into Restore. The recovered copy must contain the original canonical bytes plus the modified inline draft with fresh local history. Check that the original file remains unchanged. Repeat after changing/removing the original disk file: canonical/draft text must become safe conflicted Source copies with no automatic Apply to the original.
5. Leave a recovery offer for later, perform new work on the same source file, Save, and restart. The deferred recovery must still be offered. Open another ordinary window during a live draft: it must not offer that live record as crash recovery.
6. Change a file externally while a draft is active or Source edits are pending. There must be no silent reload. Cancel reload must preserve the draft/current Source; explicit resolution and reload must be undoable and must not overwrite the external disk file.

M3V gate exit still requires the complete G1–G7 evidence, all eight PRD scenarios, native acceptance, and explicit review of the Visual-default decision. This package does not change those criteria or begin M4.

## User-guided packaged-app evidence, November 1

Observed in this chat, distinct from mocked transport and service tests:

- Mode/tab navigation Cancel preserved the draft; Discard preserved canonical content; Apply committed one document history step. Undo/Redo propagated as expected.
- Closing a dirty tab with a modified draft produced the draft prompt and then the canonical prompt. Cancel at the second prompt retained both tabs and draft 21 despite the earlier staged Discard. Repeating with draft Discard and canonical Save reopened the file at the applied value 20.
- With two windows on the shared document, Quit Cancel preserved draft 22 over saved canonical 20. After Apply, both windows showed 22; canonical Quit Cancel retained both views and unsaved content.
- During Quit, Save of the shared file succeeded. Cancel at the later Untitled prompt kept every window open without undoing that completed Save. Repeating Quit and discarding the disposable Untitled closed both windows.
- A modified draft 23 over saved canonical 22 was offered after an interrupted session. Continue without restoring retained the offer across a later restart. Restore created an Untitled recovered copy and reopened its draft in the prototype. Applying changed only the recovered copy; the named original remained 22. The recovered copy saved separately as Package E Recovered Test.md with 23. Both saved windows subsequently closed without prompts.
- November 2 read-only inspection independently confirmed the original disk file contains 22 and the separate recovered file contains 23.

The exact termination mechanism was not instrumented in the user-guided run. Changed/missing-base recovery, Save failure during native Quit, all native entry paths, external edits during a draft, and repeated-request behavior still require the remaining automated/native evidence. These observations do not by themselves close the full M3V gate.

## Autonomous follow-up, November 2, 2026

Environment: macOS 27.2, Darwin arm64. Baseline remains `dc23ba4`; all E and follow-up changes remain uncommitted. No original fixture bytes were regenerated. The normal user session/recovery records were preserved; native fault injection used `/private/tmp/markdown-viewer-autonomous` and a separate app-data directory selected with `MARKDOWN_VIEWER_DATA_DIR`.

### Corrected defects and completed work

- **Source newline coordinates:** actual CodeMirror normalizes CRLF/CR to one editor unit, while the previous adapter indexed canonical separators. SourceBuffer now maps editor coordinates to canonical UTF-16 positions before UTF-8 conversion, preserving untouched mixed endings. Reconciliation maps in editor coordinates and does not submit another user transaction. Source/Visual context transfer uses the same mapping.
- **Cross-mode navigation:** safe exact source selections enter the appropriate Visual leaf; unsupported spans fall back to a source-bound block. Return-to-Source selections are mapped through intervening edits; surrogate/combining/ZWJ boundaries fall back safely. Reader elements carry source anchors for entry navigation.
- **Bounded large-document rendering:** mapping supports up to 2 MiB / 100,000 lines / 200,000 mapped nodes, depth 32, with at most 60 top-level blocks mounted per page. Existing block/draft preview limits remain visible; a single oversized block uses a bounded Source-only excerpt. Large mapping and direct-edit preparation run in terminating workers with six-second deadlines. Superseded mapping workers are terminated and late results ignored. A confirmed direct-edit map remains available while the background projection catches up.
- **Packaged worker defect:** the browser export of decode-named-character-reference requires `document`, so worker unit tests using Node resolution did not expose a native failure. Vite now selects the dependency's DOM-free worker condition consistently. Production worker artifacts are executed without DOM globals by `scripts/check-workers.mjs`; this runs in CI after the web build. No extra worker/blob CSP permission was retained.
- **Long-line input:** the original 1 MiB fixture contains no newline characters. Synchronous Markdown parsing of this single line exceeded the 16 ms input target. Such long-line Source documents remain editable with plain highlighting; ordinary multiline Markdown retains highlighting. No file content is normalized to solve the performance issue.
- **Usability and windows:** Open Recent is available with tabs open; ordinary windows have unique identities, with a matching narrow capability rule. Quit prompts include a numbered display name and a bounded content preview to distinguish multiple Untitled documents.
- **CI:** Rust audit failures no longer disappear behind `cargo audit || true`. Production worker validation runs after the web build.

### Native observations on the rebuilt application

1. A BOM/CRLF disposable file survived Source/Read/Split/Visual/Source and Save byte-identically. A Source append after CRLF lines changed only the appended bytes, with the entire preceding BOM/CRLF buffer checked independently.
2. A heading selected in Source entered Visual with that exact heading selected. Typing its replacement and returning to Source changed the intended heading; surrounding markup, protected comment and separators remained intact.
3. A shared prototype received a direct cell edit. Removing the disposable save target during a coordinated Quit made Save fail visibly while the prompt remained open. Cancel retained the edited value. Restoring the target allowed Save to succeed. Shared Undo/Redo still worked afterward.
4. An external file edit during a modified table draft produced the disk-change dialog rather than automatic replacement. Canceling reload retained draft 25 and canonical 24. Explicit draft Discard/reload loaded the external content; document Undo restored the prior canonical content in one step, and Redo restored the external content.
5. The 1 MiB original corpus file entered Visual using the real packaged worker. Its oversized single block was explicitly Source-only. Returning to Source and saving produced bytes identical to the original fixture.
6. A modified draft 26 was independently confirmed in a durable recovery record over saved canonical 24. The single identified isolated test executable was terminated with SIGKILL, then the original disk base was changed. Relaunch offered recovery. Restore created two separate Untitled Source copies: canonical 24 with the pre-crash text and draft 26. The original named document retained the post-crash disk edit and canonical 24. No blind draft Apply was offered against the changed file.
7. Native-menu Quit presented the unsaved-document prompt. A repeated Command-Q left that prompt intact and reported that another request was active. Cancel preserved all four tabs, including both recovered copies. Resolving both disposable Untitled prompts subsequently exited the process, verified with a process inventory rather than relaunching the app through an observation call.
8. On the final candidate, an unsaved Source suffix appeared in a second ordinary window. Clicking its exposed native close button closed that view; the surviving window retained the suffix and unsaved indicator. Command-Q then prompted for that shared document. Discard exited the identified executable; process inventory confirmed no candidate process remained and an independent disk check confirmed the test suffix was not saved.

### Automated validation

- `pnpm test`: **416 passed**, 24 files.
- `pnpm typecheck`: passed (also part of both web/native builds).
- `VITE_M3V_VISUAL_PROTOTYPE=0 pnpm build:web`: passed.
- `node scripts/check-workers.mjs`: passed against production artifacts: 1 MiB complete mapping, named entities, localized CRLF editing, no DOM access.
- `cargo test --manifest-path src-tauri/Cargo.toml --offline`: **86 passed, 1 ignored** subprocess fixture entry; no failures.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --offline --all-targets -- -D warnings`: passed.
- `VITE_M3V_VISUAL_PROTOTYPE=1 pnpm tauri build --bundles app`: passed after the final prompt/navigation changes. Candidate: `src-tauri/target/release/bundle/macos/Markdown Viewer.app`.
- `pnpm audit --audit-level=high --json`: exit 0; zero moderate/high/critical advisories, one low advisory.
- `cargo audit --file src-tauri/Cargo.lock --json`: exit 0; zero vulnerability findings, four unmaintained dependency warnings and one unsoundness warning (`glib` 0.18.5, RUSTSEC-2024-0429). `cargo tree --offline -i glib@0.18.5` reported no current macOS dependency path. The all-target graph could not be resolved offline because an Android dependency was uncached; Windows/Linux exposure remains unverified and requires dependency review before release.
- `git diff --check`: passed.

An isolated actual CodeMirror adapter profile with 30 synchronous changes recorded p95 **2.14 ms** for the original single-line corpus and **1.80 ms** for representative multiline Markdown. It excludes native IPC and painting and is not the complete M5 release benchmark. Existing large-chunk and ineffective dynamic-import build warnings remain.

### Gate status and outstanding work

The overall M3V gate is **not declared passed**. Required native Dock Quit coverage is blocked by the current Computer Use policy session. The user explicitly approved a temporary allow rule for `com.apple.dock`; it is saved alongside the Markdown Viewer exception, with default denial unchanged. The tool still denied Dock access after a JavaScript-session reset. A desktop-client policy reload/restart is the next access step; remove the temporary Dock exception after testing.

The full G1–G7 acceptance record and native entry-path checks must be closed before advancing to M4 or enabling Visual by default. This follow-up does not claim full Visual editing, M4, exports, release readiness, signing/notarization, or Windows/Linux parity. Preserve this checkpoint and continue the already-authorized remaining milestones after access is refreshed; do not ask the user to perform the application walkthrough.

### Acceptance reconciliation for continuation

This is an evidence inventory, not a substitute for the plan's assertions. Passing the whole automated suite does not establish every native assertion.

| Gate | Evidence available | Still to close |
| --- | --- | --- |
| G1 no-edit stability | Corpus/component tests; packaged BOM/CRLF and original 1 MiB byte checks; exact heading selection transfer | Consolidate complete corpus mode/history/metadata evidence; verify Reader-scroll return context and safe fallbacks end to end |
| G2 localized edits | Fixture expectations, Source newline adapter tests, native heading/table changes and preserved surrounding bytes | Reconcile each required edit/fence/protected-neighbor expectation with its exact test |
| G3 shared history | Registry/store replay tests; user-guided three-view Apply/Undo/Redo; autonomous shared direct edit/history | Record the full mixed Source/mode/Visual/draft sequence against the final candidate |
| G4 draft lifecycle | CM/component tests; user-guided valid/invalid table and Mermaid, Revert/Undo, Apply/Cancel | Map all eight PRD scenarios below to exact automated tests and final-candidate native evidence |
| G5 ownership/transactions | Rust and TypeScript stale identity/revision/range/ownership and competing-session regressions; native ownership handoff | Complete assertion-by-assertion evidence index; no native concurrency claim inferred from mocks |
| G6 exits | Keyboard and menu Quit, repeated request, Cancel, failed Save, staged Discard, native shared-view red close | Dock Quit blocked by policy-session reload; no-focused-window Quit and final repeated two-window entry-path matrix remain unverified |
| G7 recovery/safety | Instrumented SIGKILL with durable draft and changed original; separate safe restored copies; worker bounds/late-result tests | Reconcile missing-base/resource/unsafe-input cases with exact regressions and retain portability limitations |

PRD §1A.5 scenarios 1–8 have corresponding implemented paths and prior test evidence: (1) four-mode no-edit switching, (2) localized changes, (3) direct table→draft→Apply→direct editing, (4) invalid preview, (5) Revert/inline Undo/Cancel, (6) mode-switch resolution, (7) isolated closed-session history, and (8) protected constructs. The complete final-candidate acceptance index remains unfinished; none is silently excluded to declare the gate passed.

Validation artifacts for this session are in `/private/tmp`: `mv-tests.log`, `mv-rust-tests.log`, `mv-clippy.log`, `mv-web-build.log`, `mv-final-build.log`, `mv-focused-tests.log`, `mv-dependency-audit.json`, and `mv-rust-audit.json`. These temporary logs are not durable committed release evidence. The isolated native data directory is `/private/tmp/markdown-viewer-autonomous`; the test app was cleanly exited after the final shared-view close check.

### Resumed acceptance and application naming

The subsequent [Marquellium acceptance checkpoint](m3v-acceptance.md) provides the consolidated G1–G7/eight-scenario evidence index and supersedes the unfinished evidence-index checklist above. It records the newer 448 frontend / 87 Rust passing results, actual Reader scroll return and native shared-history/window-menu observations, plus the remaining Dock timeout. Current validation logs are preserved in `docs/validation/2026-11-02/`. The overall gate remains pending; no M4–M6 completion is implied.

## Final M3V acceptance completed — November 2, 2026

The [final acceptance record](m3v-acceptance.md) supersedes the pending-gate and Dock-access limitations in the historical sections above. Actual Dock Quit and instrumented no-focused-window cases passed using the user-authorized AppleScript fallback. Native testing exposed and corrected an AppKit termination bypass and minimized resolution prompts. Focused regression coverage plus the repeated native matrix verified Cancel, staged Discard, repeated requests, failed/successful Save, shared-window close and immediate typing→Quit.

Final validation: 448 frontend tests / 26 files, 88 Rust tests passed / one existing fixture ignored, Clippy with warnings denied, default web build/typecheck, opt-in native build and bundled worker checks. Final evidence uses `docs/validation/2026-11-02/m3v-final-*`. Source remains the explicitly reviewed normal default pending M4's full Visual implementation; FR-042 is still open. M4–M6 are not delivered by this gate pass. No commit or push was performed.
