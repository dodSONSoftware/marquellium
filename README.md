# Marquellium

A local-first, cross-platform **Markdown viewer and editor** — Read, Source, Split, and Typora-style Visual modes — built to the [PRD v2.0](docs/prd.md) in this repository.

**Governing engineering principle: correctness and document integrity before editing convenience.** Canonical Markdown is authoritative; visual edits preserve unrelated source byte-for-byte.

## Status

Current checkpoint (November 2, 2026): M0–M3 foundations, M3V acceptance, and **M4 editing/document features** are implemented and validated on macOS arm64. The reviewed checkpoint includes the M3V follow-ups, M4/M5 functional delivery and M6 portability work; see the [checkpoint review](docs/checkpoint-review-2026-11-02.md). M5 functional delivery is implemented; release acceptance remains open. M6 portability delivery is underway: macOS and Debian arm64 file-open/native smoke checks pass; Windows and the full platform acceptance matrix remain open. See [M6 results](docs/m6-results.md).

- **M0:** architecture, ADRs, fixtures and scaffold established.
- **M1–M3:** document durability, multi-window registry, Reader, Source/Split, shared history, sessions and recents implemented.
- **M3V:** source maps, localized Visual edits, isolated drafts, real previews, coordinated lifecycle and persistent draft recovery implemented. See [package D evidence](docs/m3v-package-d-results.md) and [package E/current validation](docs/m3v-package-e-results.md).
- **M4:** supported Visual editing, table helpers, real Mermaid/KaTeX previews and drafts, frontmatter visibility, mapped scroll sync, workspace tree/exclusions/search, local-link validation, image paste and command palette implemented. See [M4 results and acceptance](docs/m4-results.md).
- **M5:** HTML/PDF/DOCX exports, preferences, native spelling and recorded benchmarks are implemented. Signing/notarization, clean-install acceptance, full accessibility and conclusive offline testing remain. See [M5 results](docs/m5-results.md).
- **M6:** Debian arm64 packages and native tests are available; Windows build/installer jobs are prepared. Native Windows execution, other Linux desktop environments, and cross-platform print/export acceptance remain.

All four modes are available in normal builds. **Visual is the default for fresh documents/settings**; existing explicit opening preferences and per-document session modes are preserved. Choose another default under **Document tools → Default opening mode**. The development-only pinned M3V harness remains available with `VITE_M3V_VISUAL_PROTOTYPE=1`; this flag is not needed for normal Visual editing.

Use **Files → Open folder…** for a scoped workspace and saved-file search, **Document tools** for image paste/link checks/frontmatter display, and **Commands…** or **Cmd/Ctrl+Shift+P** for the keyboard-driven palette. Table controls include row/column helpers and explicit source drafts. Unknown constructs remain visibly protected and source-editable. Recent documents are available from **Open Recent** while tabs are open as well as from the empty screen.

The application is named **Marquellium**. The existing `com.markdownviewer.desktop` identifier, app-data directory, preference keys, and internal Rust executable/crate names are retained for compatibility with existing sessions and recovery records. Packaged macOS builds are named `Marquellium.app`.

The [current M3V acceptance index](docs/m3v-acceptance.md) maps G1–G7 and all eight PRD scenarios to tests and native observations. Validation logs are retained in `docs/validation/2026-11-02/`. Actual Dock Quit and no-focused-window resolution passed using the user-authorized AppleScript fallback. Final evidence uses the `m3v-final-` log prefix; native validation found and fixed the AppKit termination bypass and hidden minimized prompts.

## Repository layout

```
src/            React + TypeScript frontend
  core/         framework-independent document engine (positions, transactions,
                source-range mapping, serializers, draft sessions) — the M3V surface
  app/          composition, tabs/windows, commands
  components/   shell presentation
  features/     documents · editor · preview · visual · outline · workspace · export
  services/     typed Tauri command facade
  styles/       themes, print styles
src-tauri/      Rust core: document registry, durability, workspace, assets,
                export, settings (least-privilege commands, no fs plugin)
fixtures/       binding test corpus: markdown (incl. roundtrip/edit-preserving),
                hostile-input (security), filesystem (workspaces), export
docs/           prd.md · architecture.md · threat-model.md · test-plan.md ·
                requirement-map.md · release-matrix.md · adr/
```

## Development

Prereqs: Node ≥ 22, pnpm 12 (via corepack), Rust stable, Xcode CLT (macOS).

```sh
pnpm install
pnpm dev                 # Tauri dev (webview + Rust)
pnpm dev:web             # frontend only (Vite, no Rust)
pnpm typecheck           # tsc --noEmit
pnpm test                # vitest (core engine, fixtures, state machines)
cargo test --manifest-path src-tauri/Cargo.toml   # Rust integration tests
```

CI: `.github/workflows/ci.yml` (typecheck, unit, Rust tests, clippy, dependency audits).

## Key decisions

See [docs/adr/](docs/adr/): stack (001), editing engines incl. the visual-mode architecture (002), rendering pipeline (003), filesystem-as-truth (004), least-privilege capabilities (005), multi-window document registry (006), cross-mode undo (007), inline-draft & close state machine (008), export feasibility (009), coordinate/encoding boundary (010).

### M5 delivery

Use **Preferences… / Cmd+,** for typography, appearance, native spelling and reset; **Export… / Cmd+Shift+E** for static HTML, native Print/Save PDF and DOCX. Exports preserve applied source and show format/resource fallbacks. See the [user guide](docs/user-guide.md), [M5 results](docs/m5-results.md) and [release gates](docs/release.md). The M5 release gate is not a signed/notarized release claim: Developer ID credentials, clean-machine acceptance and remaining acceptance checks are explicit in the report.
