# Reviewed development checkpoint — November 2, 2026

This local checkpoint records Marquellium development after `dc23ba4` (the prior M3V prototype commit). The commit containing this file is the checkpoint identifier. It is a development checkpoint, not a signed release or a declaration that M5/M6 acceptance is complete.

## Included scope

- M3V acceptance follow-ups: document integrity, cross-window history, coordinated close/Quit/Cancel, draft ownership and persistent recovery, with recorded native acceptance.
- M4 supported Visual editing, tables, math/Mermaid, frontmatter, navigation, workspaces, local links, clipboard images and command palette.
- M5 exports, preferences, native spelling, keyboard/dialog behavior, performance tooling, documentation and release preparation.
- M6 file opening, single-instance routing, Windows local-media compatibility, platform menu guards, Linux packaging and native smoke automation.
- The existing Marquellium design assets and their archive, source fixtures, ADR updates, tests and dated validation evidence.

Build targets, node_modules, normal user documents/data, environment files and credentials are excluded. Native candidate binaries/installers remain ignored local outputs; their hashes are retained in the evidence manifests.

## Review performed

This was a focused self-review of the accumulated working tree against the prior Git checkpoint, including the staged inventory. It was not an independent external review or an exhaustive security audit.

Reviewed high-risk document/lifecycle paths, recovery/persistence changes, file-open ownership and navigation integration, media URL/scope boundaries, export behavior, configuration/CI, acceptance scripts, and the milestone status/evidence descriptions. Existing regression coverage was rerun. No new blocking issue was identified within this review's scope.

Checkpoint/documentation issues were corrected:

1. The global `*.log` ignore rule would have omitted native/build/test evidence referenced by milestone reports. A narrow `docs/validation/**/*.log` exception retains that evidence without including unrelated local logs.
2. README status still described M5 functionality as outstanding and the completed work as uncommitted. Its current status now distinguishes delivered functionality from open release gates and links this checkpoint.

The brand archive passed ZIP integrity and path checks. A credential-pattern scan of Git-visible files found no matching private-key, AWS access-key, GitHub-token or OpenAI-style token patterns. That scan is a limited check, not proof that arbitrary sensitive data cannot exist. Dated acceptance evidence intentionally includes disposable local paths and observed platform details; no publication was performed.

Captured evidence and imported SVG assets retain their original bytes, including tool-generated whitespace and terminal control characters. Narrow Git attributes disable line-ending conversion/whitespace linting only for those paths. Source whitespace remains checked; one surplus EOF blank line in `direct-adapter.ts` was removed without behavioral changes.

## Validation rerun for this checkpoint

| Command/check | Result |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS: 498 tests, 38 files |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | PASS: 107 passed, 1 existing fixture entry ignored on macOS arm64 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings` | PASS |
| `pnpm build:web` | PASS; existing large-chunk advisory remains |
| `node scripts/check-workers.mjs` after the fresh web build | PASS |
| Python acceptance-script parsing, shell signing-script syntax, Node worker-check script syntax | PASS |
| M6 candidate manifest hashes | All recorded entries match the current local candidates/source/configuration |
| Prior protected fixture/evidence hashes from M5 manifest | 43 checked; zero mismatches |
| Git whitespace checks | PASS for source/docs; captured evidence and imported SVG whitespace are explicitly preserved |

No new native GUI, Linux-container, Windows, signing or notarization acceptance was run for this Git-only checkpoint. Earlier native results remain explicitly attributed to the dated milestone reports. Historical manifests were not refreshed to conceal changed artifacts.

## Milestone state and remaining gates

- **M3V and M4:** recorded macOS arm64 acceptance passed.
- **M5:** functional delivery implemented; production Developer ID signing/notarization, stapled distribution and clean installation remain open. Full VoiceOver/accessibility, conclusive offline/network capture and cold-cache performance acceptance also remain open. DOCX content verification does not establish Microsoft Word visual layout.
- **M6:** installed Debian arm64 suite passed 17 native checks; packaged AppImage extract-and-run suite passed 16. Windows build/install/native tests have not run. Linux native menu accelerators, broader desktop/Wayland acceptance, direct AppImage/FUSE launch and Windows/Linux native print/export acceptance remain open. The focused suites do not replace the complete platform save/close/recovery matrix.
- Windows CI/installer jobs are prepared but were not dispatched. No Git remote is configured at this checkpoint.

See [M3V acceptance](m3v-acceptance.md), [M4 results](m4-results.md), [M5 results](m5-results.md), [M6 results](m6-results.md), and [release gates](release.md). Earlier reports are historical records; their statements about later milestones describe their respective creation times.

This checkpoint is local only. No push, tag publication, release publication, signing upload or deployment is part of it.
