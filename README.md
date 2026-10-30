# Markdown Viewer

A local-first, cross-platform **Markdown viewer and editor** — Read, Source, Split, and Typora-style Visual modes — built to the [PRD v2.0](docs/prd.md) in this repository.

**Governing engineering principle: correctness and document integrity before editing convenience.** Canonical Markdown is authoritative; visual edits preserve unrelated source byte-for-byte.

## Status

Milestone status per [docs/requirement-map.md](docs/requirement-map.md) and [docs/test-plan.md](docs/test-plan.md) gates:

- **M0 — Architecture, ADRs, fixtures, scaffold:** done (see `docs/adr/`, `fixtures/`, this scaffold)
- M1 — Scaffold + document durability
- M2 — Reader + core renderer
- M3 — Editor + split workflow
- **M3V — Visual editing fidelity prototype (mandatory gate before full Visual mode)**
- M4 — Technical document features
- M5 — Export, polish, release
- M6 — Windows/Linux portability

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
