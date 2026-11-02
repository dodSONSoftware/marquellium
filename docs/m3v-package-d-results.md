# M3V package D results

Date: November 1, 2026. Environment: macOS, Darwin arm64.
Baseline: `4884782450a8afe90ac9df51be4f9d150cc216da`, with packages A–D recorded together in the local checkpoint. Package E remains unstarted.

Package D's bounded prototype is implemented and its automated validation passes. **The overall M3V acceptance gate remains pending.** The focused user-guided native walkthrough has passed after the fixes documented below; the plan's complete G1–G7 acceptance sequence has not been completed. Package E has not started; this record does not amend the plan, PRD, ADRs, or Visual default.

## Implemented scope

- Source-map-based paragraph/heading text inputs and existing table-cell text inputs use localized canonical transactions. Existing punctuation, escaping, emphasis/link syntax, gaps, BOM metadata, line endings, and unrelated blocks are preserved. Unsupported structure changes fail visibly and retain the desired text; they never fall back to whole-document replacement.
- Table and Mermaid source editors use the actual draft-session API and isolated CodeMirror history. Revert stays on the left, Cancel/Apply on the right. Invalid previews retain the last valid result and diagnostics, disable Apply, and permit explicit retry. Cancel changes no canonical bytes/history; Apply uses the existing atomic registry path.
- Protected constructs use Reader's existing escaping and URL policies plus explicit source editing. Diagram SVG is displayed as a Blob image, never inserted into the document DOM as HTML.
- Real Mermaid parse/render runs in a separate, disposable copy of the native executable with an incognito hidden WebKit view. That process registers only input/result commands, has no document registry or plugins, and has no core/plugin capability permissions. The parent enforces timeout/cancellation by terminating and reaping it independently of its JavaScript thread. Main/document window capabilities exclude the helper.
- The development harness opens a separate window pinned to the active canonical document. It attaches a real registry view, receives canonical updates, and exposes document Undo/Redo and Save. It blocks closure while an edit is unresolved or applied changes need saving. This guard is deliberately limited to the harness; application-wide draft resolution is package E.

Mermaid's documented strict mode encodes HTML labels and disables click actions; the prototype also rejects document-supplied configuration, callbacks, styles, HTML, and resource URLs. See [Mermaid configuration and security](https://mermaid.js.org/config/usage). SVG image embedding is an additional boundary, not permission to trust engine output as app DOM; see [MDN SVG as an image](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image).

## Enforced prototype limits

| Boundary | Limit / behavior |
| --- | --- |
| Visual document | 128 KiB UTF-8, 2,000 lines, 8,192 characters per line, 500 top-level blocks, mapped depth 32 / 10,000 nodes, plus indentation/quote preflight. Refusal leaves editing available in Source. |
| Direct text | Existing supported text leaf, nonempty single line, at most 2,048 UTF-16 units; reparse must retain the document AST shape and selected leaf identity. Ambiguous entity spellings require source editing. |
| Draft preview | 16 KiB UTF-8 / 256 lines; source/table maps have depth 32 / 5,000 nodes. Tables require exactly one GFM table with matching cells, at most 100 rows / 20 columns. |
| Mermaid subset | Flowcharts, sequence diagrams, class diagrams. Real parser validation follows policy validation. Advanced configuration/resources remain protected. |
| Native helper | Six-second deadline; at most two concurrent helpers; 2 MiB stdout cap; 512 KiB SVG cap; Mermaid edge budget 100. Cancellation and deadline terminate the helper process. This is not an OS memory quota. |
| Render scheduling | 150 ms abortable debounce, serialized per document webview; obsolete requests/results are ignored. Capacity exhaustion is a visible retryable validation failure. |

These are explicit development limits, not exclusions from final acceptance. In particular, the 1 MiB corpus remains covered by source mapping/fidelity tests but is Source-only in this Visual prototype. Large-document Visual performance, complete mode transitions, and native latency remain unverified; a successful limited prototype does not pass those gates.

## Regression coverage

- Independent BOM/CRLF direct-text and escaped-pipe table input/expected fixture pairs under `fixtures/markdown/m3v/`, exercised by the existing fidelity harness as well as direct-adapter tests.
- Literal punctuation and escaped text, Unicode, structural refusal, rapid serialized inputs, stale revision rejection, retained failed input, and bounded source mapping.
- Actual React components and actual CodeMirror editor/history under pinned development dependency `jsdom@26.1.0`: direct text, table direct→draft→Revert→local Undo→Apply→canonical Undo→direct editing, invalid table/last-valid preview, Cancel, concurrent-source staleness, Mermaid invalid-fence→restored Apply preserving tilde fences/info/CRLF/neighbors, protected HTML, image-only diagram display, and document limits.
- Preview supersession, delayed results, disposal, fence boundaries, input restrictions, source/table budgets, debounce, native request cancellation, and helper capability separation.
- Native subprocess tests for success, a worker that never returns, cancellation, output flooding, input/concurrency limits, and window/request ownership. The one ignored test is the subprocess fixture entry: the passing tests invoke it explicitly as a child with controlled behavior; it is not a skipped acceptance case.

The component tests use a protocol double for registry calls and geometry shims for CodeMirror. They do not establish actual IPC, native focus/menu behavior, or cross-window GUI acceptance. Rust registry tests independently exercise atomic canonical and lease behavior. The real production helper checks below establish actual Mermaid/WebKit execution, not interactive draft acceptance.

## Validation results

| Command / probe | Result |
| --- | --- |
| `pnpm test` | **381 passed**, 19 test files, including the direct-input and shared-save follow-ups below. |
| `pnpm typecheck` | Passed. |
| `pnpm build:web` | Passed, normal default build. |
| `cargo test --manifest-path src-tauri/Cargo.toml --offline` | **64 passed, 1 ignored** subprocess fixture entry; no failures. |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --offline --all-targets -- -D warnings` | Passed after moving the acceptance-probe function before the test module. |
| `VITE_M3V_VISUAL_PROTOTYPE=1 pnpm tauri build --bundles app` | Passed; built the opt-in macOS `.app`. |
| Packaged executable `--mermaid-preview-check` | Real flowchart, sequence, and class fixtures rendered SVG with shapes: 37,679 / 26,359 / 24,110 bytes respectively. Invalid syntax and callback URL each rejected with exit 1. Run after tightening helper capabilities. |
| `git diff --check` | Passed. |

The web build reports a large-chunk warning (including the bundled Mermaid engine) and an ineffective dynamic-import warning for Tauri's window module. No warning was suppressed. Installed runtime dependencies were not upgraded; Tokio process/I/O features were enabled, and jsdom was added solely for component tests.

Built app: `src-tauri/target/release/bundle/macos/Markdown Viewer.app`.
Native GUI automation was unavailable under the session's application-control policy. The initial automated run did not establish native interaction; subsequent user-guided evidence is recorded below.

### Direct-input follow-up, November 1

Native user testing found that heading text entered directly could remain visible only in the prototype, accompanied by `edit changes Markdown structure` and retained-text feedback. A trailing heading space or temporarily empty field reproduced this: preparation rejected it before dispatch, but the controller treated it like an uncertain canonical commit and permanently blocked subsequent valid input.

Two new React/component regressions reproduced the failure before the fix and pass afterward. The controller now permits a new input value to validate against the same captured map after a preparation-only rejection; it never retries a failed/uncertain commit or rebases a stale revision. The existing stale-revision regression also verifies that more typing does not dispatch another request after a commit failure. Rejected values remain local and continue blocking Save/close until corrected or canceled.

Follow-up validation: 377 frontend tests passed; TypeScript and diff whitespace checks passed; the opt-in macOS app was rebuilt. Rust source was unchanged, so Rust tests and actual Mermaid helper checks above remain the earlier package D evidence. The user subsequently confirmed direct heading typing updates Source automatically, as recorded below.

### User-guided native checks and shared-save follow-up, November 1

The user subsequently confirmed the fixed heading input, bold-text editing, literal punctuation, Unicode, direct table escaped-pipe editing, table draft isolation/Revert/local Undo/Apply/canonical Undo/Redo, invalid table retention and Cancel, real Mermaid valid/invalid previews with last-valid retention, Apply/Cancel, sequence/class edits, longer tilde-fence preservation, and duplicate-paragraph targeting. Source edits made a Mermaid draft stale, disabled Apply, retained local text, and survived Cancel; shared Undo/Redo continued working. Saving, closing one prototype, and reopening a prototype retained the tested values.

With Source plus two prototypes, a competing table draft was refused; after the first owner canceled, the other prototype acquired and applied a draft, updating all three views. Shared Undo/Redo from the other prototype passed after explicitly focusing its title bar first. The initial apparent Undo failure was not reproduced after window activation; do not classify that observation as a proven history defect.

Saving from the second prototype then produced an unexpected external-change dialog in Source, while the saving prototype reported success. The test file on disk was checked read-only and contained Alpha amount `12` and the applied flowchart/sequence/class changes. Investigation found that no frontend subscribed to the existing `document-saved` event, and the watcher could observe the file replacement before saved metadata was published.

The fix serializes canonical snapshot, revision-checked disk save, saved metadata, and watcher disk reads with the registry lock. Genuine external changes still notify; failed saves leave dirty content/path/history intact. Both app shells now subscribe to the saved event and refresh authoritative metadata, even at an unchanged text revision. Pending Source edits remain pending, and unrelated documents are not adopted by save events. Save notifications do not flush edits or create history entries.

Focused regressions cover concurrent save/watcher observation, real external changes, failure preservation, Save As path publication/history, three-mirror saved-state refresh, retained pending Source groups, unrelated-document filtering, and application-wide saved-event delivery. Full validation after the fix: **381 frontend tests**, **64 Rust tests** with the existing ignored worker fixture entry, TypeScript, Clippy with warnings denied, and the opt-in app build. The user retested the rebuilt app with Source plus two prototypes: changing Alpha from `12` to `13` synchronized all views; saving from the second prototype cleared the Source unsaved indicator without an external-change dialog. Closing that prototype preserved both surviving views and amount `13`. The remaining prototype and app then closed normally; after a full restart, the user confirmed Source and a newly opened prototype retained `13`, the flowchart remained Start → Done, and no draft or unsaved indicator appeared. These native save, view-lifetime, clean shutdown, and persistence checks pass for the tested sequence. Package E and the full M3V acceptance gate remain unstarted/pending respectively; these checks do not establish crash recovery, global quit atomicity, full byte-for-byte corpus acceptance, or large-document Visual performance.

## Focused native follow-up

Use disposable copies of fixtures. This build is opt-in; an ordinary build keeps Visual unavailable. To reproduce the build:

```sh
VITE_M3V_VISUAL_PROTOTYPE=1 pnpm tauri build --bundles app
open "src-tauri/target/release/bundle/macos/Markdown Viewer.app"
```

1. Open a scratch Markdown file in the normal Source window, then select **M3V prototype** in the toolbar. Keep both windows on that document. Change a plain paragraph, heading text inside emphasis, and an existing table cell. Verify Source updates, literal inserted punctuation stays literal, and Undo/Redo updates both views without further typing.
2. Open table source, edit, Revert, then Undo inside the editor. Verify Revert is locally undoable and Source stays unchanged. Apply once; document Undo must undo the entire Apply. Confirm direct cell editing resumes afterward.
3. Open Mermaid source from a copy of `mermaid-math.md`. Make a valid change, then invalid syntax. Verify the last valid image stays visible, diagnostics appear, and Apply is disabled. Restore valid syntax, Apply, and verify only the authorized fence changed in Source. Repeat with Cancel; canonical content must remain unchanged.
4. While a draft is open, edit canonical Source from the other window. Verify the draft is retained and marked stale, Apply is blocked, and Cancel safely returns to the current canonical document. Attempt another draft owner; it must not replace the existing lease.
5. Resolve the draft, save applied changes, and close the prototype. Unresolved drafts/pending edits or dirty canonical content must visibly block this harness's close request. Full Quit/Cancel, tab/mode navigation, draft crash recovery, and all-windows resolution-before-destruction are **package E**, not acceptance claims of this build.

Stop on unrelated byte changes, accepted stale Apply, lost draft text, diverged histories, or preview work that cannot be stopped. Preserve the failing scratch file and exact actions. Do not enable Visual by default or start M4 on a partial pass.
