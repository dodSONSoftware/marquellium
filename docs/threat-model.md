# Threat Model

M0 (2026-10-29). Scope: local-first desktop app opening **untrusted** Markdown from any location the user points it at. Threat actors: malicious documents (deliberate or accidental), malicious diagrams, hostile filenames/paths, compromised supply chain. Out of scope (v1): network actors (no sync/cloud), other local users (single-user app), OS-level kernel exploits.

## Assets

1. **User's files** — documents and assets must never be silently overwritten or corrupted (highest priority, per PRD §1B).
2. **User's machine** — no code execution from document content.
3. **User's privacy** — local file metadata/names must not leak to third parties (remote image URLs, tracking pixels).
4. **App integrity** — predictable behavior under malformed input (no crashes-as-data-loss).

## Threats, mitigations, and verification

| ID | Threat | Mitigation | Verified by |
|---|---|---|---|
| T1 | **XSS / script execution** from Markdown (`<script>`, event handlers, `javascript:` URLs, `data:` vectors) | Raw HTML never executed (escape-by-default, ADR-003); react-markdown without rehype-raw; single audited URL policy (`http/https/mailto/#fragment/relative/local-media:` only); CSP denies remote script/style, `object-src`, `base-uri` | `fixtures/hostile-input/*` render tests (M2): assert no `<script>`/handlers in output; URL policy unit tests |
| T2 | **Mermaid injection / DoS** (resource-exhaustion diagrams; known 2026 advisories) | Mermaid `securityLevel: "strict"`; controlled config (no `click`/external callbacks); input size cap per diagram; render-time budget with timeout ⇒ source fallback; dependency pinning + advisory tracking (M5 checklist) | `hostile-input/mermaid-bomb.md` (M2/M4): renders as fallback within budget; no crash |
| T3 | **Path traversal / symlink escape** via image/link refs (`../../etc/passwd`, symlinks out of workspace) | `local-media:` handler canonicalizes then scope-checks path components; all Rust commands canonicalize + scope-check (ADR-005); no fs plugin granted | Rust negative tests: traversal, symlink out, NUL byte, `..` (M1/M2); `hostile-input/path-traversal.md` |
| T4 | **Remote image tracking / privacy leak** (opening a doc fires remote requests) | Remote images off by default; CSP `img-src` without remote http(s) for document content; explicit enablement preference with disclosure (M5) | Offline E2E (NFR-006): no network requests with network disabled |
| T5 | **Silent overwrite of external changes** (stale save) | Revision-checked save (mtime-ns + size + sha256) with temp+atomic rename; conflict ⇒ no write, resolution flow (ADR-004, AT-108) | Rust integration: concurrent external edit between read & save ⇒ `conflict`, file intact |
| T6 | **Data loss on crash / interrupted write** | Atomic writes; debounced recovery snapshots in app data (separate from original); opt-in restore; no torn snapshots (temp+rename for snapshots too) (ADR-004, NFR-004) | Rust: kill mid-write ⇒ original intact, snapshot restorable; M1 fault tests |
| T7 | **Encoding corruption** (invalid UTF-8, BOM loss, surrogate splitting) | UTF-8 validation at read (refuse/convert flow, never silent); BOM flag round-trip; branded offset types with boundary rejection (ADR-010, AT-116) | `roundtrip/*` byte-exact tests; `hostile-input/invalid-utf8.md` refusal test; position-boundary unit tests |
| T8 | **Oversized/hostile documents** (10 GB file, deep nesting, entity bombs) | 10 MB default open limit (actionable error); parser input caps; recursion-depth guards in list/quote rendering; stale-render cancellation (revision check) | `hostile-input/` size/nesting fixtures; NFR-002 benchmark fixture |
| T9 | **Supply chain** (compromised dependency) | Pinned versions (pnpm-lock, Cargo.lock committed); per-milestone `pnpm audit`/`cargo audit` in CI; no postinstall scripts policy; dependency license inventory in release matrix; Mermaid advisory watch (known 2026 history) | CI gates (M1+); release matrix (M5) |
| T10 | **Export-side injection** (exported HTML carrying live scripts/remote refs) | Exports reuse the same pipeline + URL policy; inlined CSS/only; no `<script>`; remote images not embedded unless already in preview policy | AT-115 export fixture tests (M5): assert script-free, self-contained output |
| T11 | **Clipboard image import** (hostile image file: oversized, dual-extension, path tricks) | MIME sniff on bytes (not extension); size cap; unique generated filenames in an assets dir; no overwrite; import scoped to workspace (ADR-005) | AssetService tests (M4) |
| T12 | **Multi-window split-brain** (two windows, one doc, divergent buffers) | Single Rust registry, revision-checked transactions, broadcast sync (ADR-006); stale ⇒ reject, never merge blind | Registry concurrency tests (M1); AT-104/117 |
| T13 | **Unintended document modification on view operations** (mode switch, scroll sync, outline click, render failure) | Mode/view operations are read-only by construction (zero-transaction invariant I1); render failures fall back to source display, never mutate | M3V gate suite (byte-identical switch); preview-failure tests (M2) |
| T14 | **TextBundle/TextPack (P2)** path traversal & bomb archives | Deferred to P2; when implemented: member path validation, size caps, no symlink members, quarantine dir (FR-009 acceptance criteria) | — (P2) |

## Residual risks (documented, accepted)

- **Webview renderer vulnerabilities** (WebKit/WebView2 bugs): mitigated by pinned OS support matrix + security updates; we cannot fix OS webviews. Tracked in release matrix.
- **KaTeX/mermaid engine bugs** on malformed input: contained by sandboxed render + timeout + fallback; both libraries are widely audited.
- **DOCX consumers:** our generated OOXML is consumed by third-party Word processors; malformed-XML risk mitigated by round-trip validation of generated XML (M5 test).
