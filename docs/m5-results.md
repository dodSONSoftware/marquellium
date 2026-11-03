# Marquellium M5 — implementation and release acceptance

Date: November 2, 2026. Platform: macOS 27.2 arm64, Apple M4 Max (Mac16,9), 64 GiB RAM. Baseline: the uncommitted M3V/M4 tree. Earlier work and fixture evidence were preserved; no commit, push, installation or publication was performed.

**Functional delivery: implemented and locally validated. Overall M5 release gate: OPEN.** Developer ID signing/notarization, clean-machine release acceptance and the remaining accessibility/offline checks below are not established by a successful development build.

## Delivered

| Area | Behavior and boundaries |
| --- | --- |
| HTML export | Static standalone document, inline CSS, embedded scoped raster images, static Mermaid SVG images and native MathML from bounded/trust-disabled KaTeX. The same Markdown dialect parser drives Read/Visual and export. Raw HTML/unknown syntax is visible escaped source. No scripts, remote images/fonts or network-based conversion. Relative hyperlinks retain their spelling and resolve from the exported file's folder. |
| PDF export | Dedicated native print-preview window participates in coordinated close/Quit. Native Print / Save PDF controls paper/scaling/output. Print controls are omitted from the PDF. Heading/content grouping prevents the observed orphan headings; task markers stay with their text. Large tables/figures can still require pagination review. Windows/Linux printing and fixed page-number templates are not claimed. |
| DOCX export | Rust generates OOXML and a stored-method ZIP, including styles, paragraphs/headings, emphasis, hyperlinks, tables, blockquotes and embedded PNG. Lists/numbering/tasks are visible text. Math/Mermaid use labeled source fallbacks; unsupported/non-PNG images retain visible source/alt text. Word-native layout, editable math, interactive lists and anchor bookmarks are not claimed. |
| Export safety | Applied source is captured after draft resolution. Native Rust owns scoped image reads, native save dialogs and atomic sibling-temp writes. Unsupported/oversized resources produce diagnostics or visible source fallbacks. Canceling the save dialog returns without writing. The source document is not an output buffer. Print previews are capped at four and cleaned up on destruction. |
| Preferences | Appearance, opening mode, document font/size/line spacing/width, independent editor font/size, frontmatter and native spelling are configurable. Saved changes broadcast across document windows. Values are bounded; unknown root/sidebar settings keys survive save/reload. Reset fills defaults; Save persists them. Settings writes are serialized and atomic. |
| Native spelling | Actual WebKit context-menu suggestions, Ignore Spelling and Learn Spelling appeared for the disposable word with spelling enabled. The same word had no suggestions/Ignore/Learn entries after disabling the preference. Source spelling toggles without remounting or committing text; inline drafts receive the same setting. No application spelling service/network API is introduced. |
| Accessibility/keyboard | Native modal focus containment, labels, Escape/close focus restoration, visible focus rings and reduced-motion support. Native preferences/export accelerators and print-window Cmd+W. During document resolution, preferences/export dialogs temporarily leave the browser top layer so lifecycle prompts remain operable; Cancel restores the unsaved form. Full VoiceOver QA remains open. |
| Statistics | Debounced worker counts approximate words, Unicode code points and reading time at 200 words/minute without scanning the document on each input event. |
| Release preparation | User guide, release checklist, reproducible native benchmark runner, independent export verifier and credential-gated signing/notarization script. The signing script was syntax-checked, not executed through a signed release. |

See `docs/user-guide.md`, `docs/release.md` and the dated implementation refinement in ADR-009. The refinement replaces a second Rust Markdown parser with shared-parser typed blocks, and corrects the original proposed KaTeX SVG backend to actual native MathML. Base64 uses the already locked 0.23.1 package; no transitive package versions were upgraded or downgraded.

## Automated validation

- **490 frontend tests across 36 files passed**, including the complete Markdown corpus, hostile fixtures, export content/fallbacks, preferences reset/suspension and spelling without document edits.
- **102 Rust tests passed; one existing subprocess-fixture entry ignored.** New checks cover DOCX parts/content, source/asset scope, atomic writes and future-key/normalization persistence.
- TypeScript, Clippy with warnings denied, normal release app build (`VITE_M3V_VISUAL_PROTOTYPE=0`), bundled browser workers, Python script compilation, shell syntax and final diff checks passed.
- The release app is about **7.55 MiB**. Local `codesign --verify --deep --strict` passed; this is an ad hoc development signature, not Developer ID/notarization. The existing large-JavaScript-chunk warning remains informational; no threshold was weakened to suppress it.
- `pnpm audit --audit-level=high` exited 0 with **one low-severity advisory**. `cargo audit` exited 0 with **six allowed warnings** (maintenance, yanked package and the existing GLib advisory). These are retained in the evidence and are not described as a warning-free dependency graph. No audit ignore list was added.

## Native and independent acceptance

All app operations used the packaged release candidate, disposable source/assets and isolated application data under `/private/tmp/marquellium-m5-acceptance`. The original export fixture in the repository was not rewritten; the disposable copy's image reference was re-rooted to its copied assets before hashing.

1. Generated all three formats through the real Export dialog/native save controls. The final PDF was written through the macOS PDF menu, without sending a physical print job.
2. Independently verified HTML has no scripts, has two MathML formulas and two embedded images (original PNG plus Mermaid SVG), and retains the expected fixture text.
3. Python's standard ZIP reader checked DOCX CRCs; the XML parser read every XML/relationship part; expected headings, table cells, code, links and labeled math/Mermaid fallbacks are present. The embedded PNG exactly matches the original asset. macOS `textutil` independently parsed the DOCX to text. Microsoft Word visual layout is not a verified result.
4. Extracted the actual saved PDF's text and rendered all three pages to PNG for visual inspection. Headings, tables, code, math, diagram and lists are legible and unclipped; the final page contains the ending fixture marker. Heading grouping and task layout were corrected after inspecting earlier print candidates. Output controls are absent.
5. Changed document size to 18 px and native spelling off, saved, and reopened Preferences: the saved values remained. Source and original image hashes stayed unchanged.
6. Enabled spelling for a disposable unsaved word and observed real native suggestions; disabled it and confirmed suggestion/Ignore/Learn entries disappeared. Undo restored the canonical original without saving the probe.
7. With an unsaved source edit and the print window focused, Quit displayed the coordinated Save/Discard/Cancel prompt. Cancel retained both windows and the edit. Cmd+W then closed only the print window; the dirty document stayed open. Undo and clean Quit completed normally.
8. With unsaved document content and an unsaved `Georgia` font entry in Preferences, Quit suspended Preferences and exposed the document-resolution prompt. Cancel restored Preferences with `Georgia` still in the form. Closing that form without saving and undoing the disposable source probe left the original intact.
9. Independent before/after SHA-256 checks confirmed source and original PNG preservation. The verifier also hashes all final export artifacts. The earlier M4 corpus hashes remain unchanged.

These are direct UI observations plus independent artifact checks. Content-free lifecycle logs are supporting evidence, not a substitute for the observations.

## Performance

The final benchmark JSON retains all 30 native fresh-process runs and 3,000 CodeMirror dispatch samples, with a live Split preview and a 1,049,836-byte technical document. No benchmark edit was saved; the fixture hash was verified afterward. OS filesystem caches were warm after the first run; no system cache purge was performed.

Measured p95 results: **997.7 ms fresh-process launch to usable Split**, **991.6 ms native entry through restore/render**, and **3.0 ms synchronous editor input handling**. These are below the 2,000 / 1,500 / 16 ms budgets under the stated conditions. Raw results are recorded in `docs/validation/2026-11-02/m5-benchmark.json`. Launch begins at Python `Popen` and ends on a native ready message after the restored Split document and two animation frames. A separate native clock excludes the dynamic loader but includes launch/restore/render. Input timing covers synchronous dispatch/handlers, not physical keystroke-to-pixel latency. These measurements are specific to the recorded hardware, fixture and cache conditions; cold filesystem-cache behavior is not established.

## Gates still open

- **Developer ID signing/notarization and clean installation:** `security find-identity -v -p codesigning` reported **0 valid identities**. No Developer ID certificate or notarization credential was created, requested through chat, or substituted with ad hoc signing. Gatekeeper/stapled distribution and clean-machine installation/file association remain unverified.
- **Conclusive offline end-to-end/network capture:** two process-scoped `sandbox-exec` profiles denied network traffic, but macOS did not register an app window accessible through either Computer Use or the authorized AppleScript fallback. The IP-denial control blocked curl; a process sample showed an AppKit event loop, not a usable acceptance session. Only the disposable processes were terminated. No global network setting was changed. This attempt is inconclusive and does not establish offline acceptance or a no-telemetry capture result.
- **Full accessibility/release matrix:** keyboard/dialog behavior was tested; VoiceOver and clean-install P0/P1 review remain unverified. Existing OS Open With/CLI file-open requirements remain assigned to the later platform work in the requirement map. DOCX Word layout and Windows/Linux native export/installer parity are not implied by macOS artifact checks.

M6 was not started. The application version remains 0.1.0; no release-ready or signed-distribution claim is made. Local M5 implementation is available for further acceptance without requiring the user to repeat the tests already recorded here.
