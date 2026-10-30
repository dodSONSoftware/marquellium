# ADR-001: Tauri 2 + Rust + React/TypeScript, pinned toolchain

**Status:** Accepted (M0, 2026-10-29)
**Deciders:** Engineering
**Supersedes:** —
**PRD trace:** §1 (recommended stack), §8.1 ADR-001, §17.3 (pin dependencies)

## Context

PRD §1 recommends Tauri 2 + Rust backend, TypeScript + React frontend, CodeMirror 6, unified/remark/rehype, Mermaid, KaTeX, and requires that versions be pinned at implementation time after dependency/security review. The initial platform is macOS (Apple Silicon); Windows and Linux follow after portability verification (M6).

## Decision

- **Shell:** Tauri 2 (v2.12.4 CLI/api), single Rust process, OS WebView (WKWebView on macOS).
- **Frontend:** React 19.3.1 + TypeScript 5.9.3, bundled with Vite 8.3.5.
- **Testing:** Vitest 5.0.5 for the framework-independent core and unit tests; `cargo test` for Rust integration tests.
- **Editor:** CodeMirror 6 (state 6.7.6, view 6.43.15, commands 6.11.1, language 6.13.1, lang-markdown 6.5.2) — see ADR-002.
- **Rendering:** unified 11.0.5 / remark-parse 11.0.0 / remark-gfm 4.0.1 / remark-math 6.0.0 / remark-frontmatter 5.0.0 / remark-rehype 11.1.2 / react-markdown 10.1.0 — see ADR-003.
- **Diagrams/math:** mermaid 12.2.0 (strict security mode), katex 0.19.1.
- **Code highlighting:** highlight.js 11.12.0.

### TypeScript 5.9.3 rather than 6.x/7.x

At pin time the registry's latest `typescript` is 7.0.2 (native compiler line) with 6.x in flight. The bundler/test ecosystem (Vite 8, Vitest 5, plugin-react 6) is certified against the 5.x toolchain. We pin **5.9.3** (latest 5.x) to avoid a first-class compatibility risk on the critical path; a TS 6/7 migration is a later, isolated task.

### Why Tauri over the alternatives (PRD ADR-001 rationale, re-confirmed)

- **Electron:** uniform Chromium renderer, but larger distribution and a second full runtime on user machines. The PRD rules out requiring runtime installs on end-user machines; the OS WebView already exists.
- **Native SwiftUI:** best macOS integration, but the React/unified rendering stack would be re-implemented per platform, defeating the cross-platform plan.
- **Rust egui:** significant cost to reach the required rich HTML/Markdown preview quality.

Accepted tradeoff: real-device webview QA on macOS/Windows/Linux is mandatory (M6) because renderer behavior differs across engines.

## Consequences

- All file I/O goes through scoped Rust commands (ADR-005).
- The webview cannot be assumed to be Chromium: CSP is enforced in `tauri.conf.json`; DOM APIs used must exist in WKWebView (Safari-class) — the minimum target is the current macOS release's WKWebView.
- Multi-window coordination relies on the single Rust process (ADR-006).
- Node/Rust are developer-only; end users get a self-contained bundle (FR: §1B.1).

## Verification

- `pnpm build:web` (tsc + vite) and `cargo check`/`cargo test` in CI.
- Release builds on macOS arm64; Windows/Linux in M6.
