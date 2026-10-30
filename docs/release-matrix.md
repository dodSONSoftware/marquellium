# Release Matrix & Dependency Audit

M0 (2026-10-29). Versions are **pinned** in `package.json` (exact) and resolved exactly in `pnpm-lock.yaml` / `Cargo.lock` (both committed). Any bump is a deliberate, audited change.

## Platform support

| Platform | Status | WebView | Notes |
|---|---|---|---|
| macOS 14+ (Apple Silicon, arm64) | **Primary — release target M5** | WKWebView (system) | Signing + notarization at M5; benchmark baseline is this machine class (documented at M3/M5) |
| macOS 14+ (Intel) | Supported (build target) | WKWebView | CI builds both arches |
| Windows 10/11 (x64) | M6 target | WebView2 (evergreen, auto-installed) | Print/PDF parity must be validated (ADR-009); installer = MSIX/NSIS |
| Linux (glibc, x64/arm64) | M6 target | WebKitGTK (system) | Distribution via .deb/.rpm/AppImage; no self-contained webview (system dependency, documented) |

Developer requirements: Node ≥ 22, pnpm 12 (corepack), Rust stable (1.99 at M0), Xcode CLT on macOS. **End users need none of these** (PRD §1B.1).

## Pinned dependency inventory (license audit)

All licenses are OSI-approved permissive (MIT / Apache-2.0 / BSD / CC0) — **no copyleft (GPL/AGPL) or source-available (SSPL/BUSL) dependencies**; compatible with any future commercial or open license choice (PRD §15.6 — final license decision deferred to M5, this audit keeps both options open).

| Dependency | Version | License | Role |
|---|---|---|---|
| react / react-dom | 19.3.1 | MIT | UI |
| typescript | 5.9.3 | Apache-2.0 | toolchain (ADR-001) |
| vite | 8.3.5 | MIT | bundler |
| @vitejs/plugin-react | 6.1.2 | MIT | bundler |
| vitest | 5.0.5 | MIT | test runner |
| @tauri-apps/api / @tauri-apps/cli | 2.12.4 | Apache-2.0 / MIT | shell (also ISC for parts) |
| tauri (Rust) / tauri-build | 2.x (Cargo.lock exact) | Apache-2.0 / MIT | shell core |
| @codemirror/{state,view,commands,language,lang-markdown} | 6.7.6 / 6.43.15 / 6.11.1 / 6.13.1 / 6.5.2 | MIT | source + inline editing (ADR-002) |
| unified / remark-parse / remark-gfm / remark-math / remark-frontmatter / remark-rehype | 11.0.5 / 11.0.0 / 4.0.1 / 6.0.0 / 5.0.0 / 11.1.2 | MIT | pipeline (ADR-003) |
| react-markdown | 10.1.0 | MIT | render layer |
| highlight.js (+@types) | 11.12.0 (+10.1.0 types) | BSD-3-Clause | code highlighting |
| mermaid | 12.2.0 | MIT | diagrams — **security advisory watch required at every release (T2)** |
| katex | 0.19.1 | MIT | math |
| serde / serde_json / thiserror / dirs / sha2 / hex / notify / walkdir (Rust) | 1.x / 1.x / 2.x / 6.x / 0.10.x / 0.4.x / 8.x / 2.x (Cargo.lock exact) | MIT / Apache-2.0 / MIT / MIT / CC0 / MIT / MIT / MIT | Rust core |

**Fonts:** system font stack only (no bundled third-party fonts at M0) → no font licensing. If a bundled UI font is ever added, it must be SIL OFL / Apache-2.0 (PRD §15.6) — tracked for M5.

## Release process gates (M5)

1. `pnpm audit --audit-level=high` and `cargo audit` green (or documented, accepted exceptions).
2. Mermaid advisory check against GitHub advisories; bump-or-document.
3. NFR-001..003 measured on the documented baseline machine; results recorded in `docs/benchmarks.md`.
4. NFR-008: network-capture verification that a release build makes zero requests offline.
5. macOS: codesign + notarization; Windows/Linux (M6): per-platform installer + file-association smoke.
6. License/branding decision recorded (final choice), consistent with the audit above.
