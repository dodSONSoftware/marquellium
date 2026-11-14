# ADR-005 — Native commands and scoped capabilities

Recorded November 13, 2026 from the implemented M0/M1 boundary. PRD sections 8.1, 8.5 and 17.4, FR-022/023/043 and NFR-009 apply.

## Decision

React calls typed commands in `src/services/native.ts`. Rust owns document reading, persistence, recovery, native dialogs and workspace access. Markdown rendering receives document content and bounded media URLs. The capability files grant no filesystem or dialog plugin access.

`src-tauri/capabilities/default.json` grants the application windows core window/event/path operations and clipboard text writing. Document commands operate on the process-wide registry. Directory listing and workspace search use per-window picker-granted roots. `workspace::resolve_in_scope` canonicalizes both paths and compares path components, with traversal and symlink escape regression tests. Media serving separately validates roots and file types. Dialog-selected documents may live outside a workspace, matching ordinary editor behavior.

The disposable Mermaid preview worker has a separate capability with an empty permission list. Its separate application command handler exposes only the preview operations. Renderer content does not acquire the editor's command surface.

## Security limits and verification

Tauri capabilities control core/plugin access. Custom application commands require their own argument validation and ownership checks. An injected script in a privileged editor webview could invoke the custom commands available there. CSP, escaped Markdown, URL validation and the separate preview process are therefore part of the boundary. The capability files alone provide insufficient evidence of complete path authorization.

The M1 verification includes actual temporary files, revision conflict rejection, workspace traversal/symlink rejection, registry revision validation and shared-document lifecycle tests. Native Open With, file associations and platform packaging require their own host acceptance. The November 13 handoff report records executed checks and remaining work.
