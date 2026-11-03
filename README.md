# Marquellium

**A modern, local-first Markdown viewer and editor for macOS.**

Marquellium is an open-source desktop application designed for reading, writing, editing, and managing Markdown documents. Built with Tauri, Rust, React, and TypeScript, it combines multiple editing modes with document integrity, native desktop integration, and a streamlined writing experience.

Developed and published by **dodson labs**.

## Features

### Four editing modes

Choose the experience that best fits your workflow:

- **Read** — View rendered Markdown in a clean, distraction-free interface.
- **Source** — Edit Markdown directly with full control over its syntax.
- **Split** — Work with Markdown source and rendered content side by side.
- **Visual** — Edit formatted content directly using a Typora-style editing experience.

Visual is the default mode for new documents and installations. The preferred opening mode is configurable in application preferences.

### Document management

- Multiple document tabs and application windows.
- Session persistence and document recovery.
- Unsaved-change detection and safe close handling.
- Recently opened documents.
- Workspace folders, file navigation, and document search.
- External file change handling and conflict protection.
- Cross-mode undo and redo history.

### Markdown editing

- Live Markdown rendering and preview.
- Mermaid diagram rendering.
- KaTeX mathematical expressions.
- Table editing helpers.
- YAML frontmatter visibility.
- Image pasting and local-link validation.
- Outline navigation and synchronized scrolling.
- Keyboard-driven command palette.
- Native spell checking.

### Export

Export Markdown documents to:

- **HTML** — Static HTML output.
- **PDF** — Native print and Save as PDF support.
- **DOCX** — Microsoft Word-compatible documents.

Some advanced formatting or embedded resources may require format-specific fallbacks.

### Local-first design

Marquellium treats your Markdown files as the authoritative source of your documents.

It is designed around several principles:

- Your documents remain ordinary Markdown files.
- Editing operations prioritize document integrity.
- Visual editing preserves unrelated source content.
- Unsupported Markdown constructs remain accessible through source editing.
- Document storage does not require a cloud service.

**Engineering principle:** Correctness and document integrity take precedence over editing convenience.

## Platform support

| Platform | Current status |
|---|---|
| macOS (Apple Silicon) | Primary development and validated platform |
| Linux (Debian arm64) | Portability testing underway |
| Windows | Build infrastructure prepared; native validation pending |

**macOS is currently the primary supported platform.** Linux and Windows support remain under development and are not yet considered release-ready.

## Project status

<text>**Active development — pre-release**</text>

As of November 2, 2026, the core application, four editing modes, document management, workspace features, and export functionality have been implemented.

Functional validation has been performed on macOS arm64. Release acceptance remains open, including signing, notarization, accessibility verification, clean-install testing, and completion of the cross-platform validation matrix.

Detailed engineering progress and validation evidence are maintained separately:

- [Development checkpoint review](docs/checkpoint-review-2026-11-02.md)
- [M3V acceptance results](docs/m3v-acceptance.md)
- [M4 feature results](docs/m4-results.md)
- [M5 export and preferences results](docs/m5-results.md)
- [M6 platform validation](docs/m6-results.md)
- [Release acceptance follow-up](docs/release-follow-up-2026-11-02.md)
- [Release requirements](docs/release.md)

Features and platform availability may change before the first stable release.

## Getting started

### Prerequisites

For macOS development:

- macOS with Xcode Command Line Tools
- Node.js 22 or newer
- pnpm 12, installed through Corepack
- Stable Rust toolchain
- Tauri system dependencies

### Build and run

```bash
# Install dependencies
pnpm install

# Launch the desktop application
pnpm dev

# Launch the frontend only
pnpm dev:web

# Type-check the frontend
pnpm typecheck

# Run frontend tests
pnpm test

# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml
```

The frontend-only development server does not provide the full native Tauri functionality.

### Basic usage

1. Open an existing Markdown document or create a new one.
2. Select Read, Source, Split, or Visual mode.
3. Use **Files → Open folder…** to browse a workspace.
4. Open **Document tools** for image pasting, link validation, and frontmatter options.
5. Open the command palette with **Cmd+Shift+P**.
6. Export a document using **Cmd+Shift+E**.
7. Configure appearance, typography, spell checking, and default opening mode through **Preferences…**.

See the [User Guide](docs/user-guide.md) for additional instructions.

## Technology stack

| Component | Technology |
|---|---|
| Desktop framework | Tauri |
| Native backend | Rust |
| User interface | React |
| Frontend language | TypeScript |
| Build tooling | Vite |
| Markdown rendering | Markdown rendering pipeline with Mermaid and KaTeX support |
| Testing | Vitest, Rust tests, native validation |

### Repository structure

```text
src/
├── core/         Document engine, transactions, source mapping
├── app/          Application composition, tabs, windows, commands
├── components/   User interface components
├── features/     Editor, preview, workspace, documents, export
├── services/     Typed Tauri command interface
└── styles/       Themes and print styling

src-tauri/        Rust backend and native integration
fixtures/         Markdown, filesystem, export and security test data
docs/             Product requirements, architecture and validation
.github/          GitHub Actions workflows
```

## Architecture and engineering

Marquellium follows a filesystem-first architecture.

Canonical Markdown remains authoritative, including during visual editing. The editor uses source-range mapping and localized transactions to avoid unnecessary modifications outside the edited content.

Other architectural priorities include:

- Document durability and recovery.
- Least-privilege native filesystem operations.
- Consistent document state across tabs and windows.
- Shared editing history across modes.
- Safe handling of unsupported Markdown constructs.
- Explicit validation of potentially unsafe content.

For implementation details, see:

- [Product Requirements Document](docs/prd.md)
- [Architecture](docs/architecture.md)
- [Threat Model](docs/threat-model.md)
- [Test Plan](docs/test-plan.md)
- [Requirements Mapping](docs/requirement-map.md)
- [Architecture Decision Records](docs/adr/)

### Testing and continuous integration

GitHub Actions performs automated validation, including TypeScript checks, frontend tests, Rust tests, Clippy, and dependency audits.

Native application acceptance testing is tracked independently of automated unit tests.

See [.github/workflows/ci.yml](.github/workflows/ci.yml) and the [release validation matrix](docs/release-matrix.md).

## Licensing

Marquellium is released under the **MIT License**.

Copyright © 2026 Randy Dodson, publishing under the name dodson labs.

See the [LICENSE](LICENSE) file for the complete terms.

## About dodson labs

**dodson labs** is an independent open-source software publishing identity operated by Randy Dodson.

Marquellium is developed and published under the dodson labs name, with copyright ownership retained by Randy Dodson.
