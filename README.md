# Marquellium

**A modern, local-first Markdown viewer and editor for macOS.**

Marquellium is an open-source desktop application for reading, writing, editing, and managing Markdown documents. Built with **Tauri, Rust, React, and TypeScript**, it combines powerful editing capabilities with native desktop integration, flexible document management, and an emphasis on preserving the integrity of your Markdown files.

With four editing modes, live previews, workspace navigation, and multiple export formats, Marquellium provides a comprehensive Markdown environment without requiring cloud services or proprietary document formats.

**Developed and published by dodson labs.**

---

## Features

### Four editing modes

Marquellium offers four complementary ways to work with Markdown documents:

| Mode | Description |
|---|---|
| **Read** | View rendered Markdown in a clean, distraction-free reading environment. |
| **Source** | Edit raw Markdown with complete control over its syntax and formatting. |
| **Split** | Edit Markdown source alongside its rendered preview. |
| **Visual** | Edit formatted content directly using a Typora-style visual editing experience. |

Visual mode is the default for new installations and documents. You can change the preferred opening mode through the application's settings.

All four modes operate on the same underlying Markdown document, preserving consistency when switching between them.

### Document management

- Multiple document tabs and application windows.
- Automatic session persistence and document recovery.
- Unsaved-change detection and safe application shutdown.
- Recent document history.
- Workspace folder navigation and document search.
- External file modification detection and conflict handling.
- Shared undo and redo history across editing modes.
- File-based document storage without proprietary formats.

### Markdown capabilities

- Live Markdown rendering and preview.
- Mermaid diagram rendering.
- Mathematical expressions using KaTeX.
- Visual table editing helpers.
- YAML frontmatter visibility.
- Image pasting and local-link validation.
- Document outline navigation.
- Synchronized scrolling between source and preview.
- Keyboard-driven command palette.
- Native spell checking.

Visual editing is designed to preserve unrelated Markdown source content. Constructs that cannot be safely edited visually remain accessible through Source mode.

### Document export

Marquellium supports exporting Markdown documents to several widely used formats:

| Format | Capabilities |
|---|---|
| **HTML** | Generate static HTML documents. |
| **PDF** | Use native printing and Save as PDF functionality. |
| **DOCX** | Create Microsoft Word-compatible documents. |

Export operations use the document's applied Markdown content. Certain advanced formatting, diagrams, or external resources may require format-specific fallbacks.

### Local-first architecture

Your documents belong to you.

Marquellium follows a filesystem-first design in which ordinary Markdown files remain the authoritative source of document content.

Core principles include:

- **Local ownership** — Documents are stored as standard Markdown files.
- **Document integrity** — Editing operations prioritize preserving existing content.
- **Source fidelity** — Visual edits preserve unrelated source content.
- **Open formats** — No proprietary document format is required.
- **Offline operation** — Document editing does not require a cloud service.
- **Recovery and durability** — Document state and unsaved changes are protected through recovery mechanisms.

**Governing engineering principle: Correctness and document integrity take precedence over editing convenience.**

---

## Platform support

Marquellium is currently developed and validated primarily for **macOS on Apple Silicon**.

| Platform | Status |
|---|---|
| macOS (Apple Silicon) | Primary development and validated platform |
| Linux (Debian arm64) | Portability testing underway |
| Windows | Build infrastructure prepared; native validation pending |

Linux and Windows support are development objectives, but neither platform is currently considered release-ready.

The application uses a cross-platform architecture; however, **macOS is the current primary supported platform**.

---

## Project status

> **Status: Active Development — Pre-release**

As of November 2, 2026, Marquellium has implemented its core application architecture, all four editing modes, document management, workspace features, preferences, and export functionality.

Functional validation has been performed on macOS arm64.

The project is progressing toward its first stable release. Remaining acceptance activities include code signing, notarization, clean-install verification, accessibility testing, and completion of the platform validation matrix.

### Development milestones

| Milestone | Description | Status |
|---|---|---|
| M0 | Architecture, design decisions, fixtures, and scaffolding | Complete |
| M1–M3 | Document durability, windows, editing foundations, sessions, and recovery | Implemented |
| M3V | Visual editing infrastructure, source mapping, and draft recovery | Validated |
| M4 | Document editing, previews, workspace tools, and command palette | Validated on macOS |
| M5 | Exports, preferences, native spelling, and performance benchmarks | Implemented; release acceptance pending |
| M6 | Cross-platform portability and native validation | In progress |

Detailed development and validation records are maintained in the repository:

- [Development checkpoint review](docs/checkpoint-review-2026-11-02.md)
- [Visual editing acceptance](docs/m3v-acceptance.md)
- [M4 implementation results](docs/m4-results.md)
- [M5 implementation results](docs/m5-results.md)
- [M6 portability results](docs/m6-results.md)
- [Release acceptance follow-up](docs/release-follow-up-2026-11-02.md)
- [Release requirements](docs/release.md)

Feature availability and platform support may change before the first stable release.

---

## Getting started

### Requirements

To build Marquellium on macOS, you will need:

- macOS with Xcode Command Line Tools.
- Node.js 24 LTS (the supported major is recorded in `.node-version`).
- pnpm 12, installed through Corepack.
- A stable Rust toolchain.
- The native dependencies required by Tauri.

### Build and run

Clone the repository and run the following commands from its root directory:

```bash
git clone https://github.com/dodSONSoftware/marquellium.git
cd marquellium

# Select Node.js 24 with your version manager before installing dependencies.
# Install dependencies
pnpm install --frozen-lockfile

# Run the desktop application
pnpm dev

# Run the frontend independently
pnpm dev:web

# Type-check TypeScript
pnpm typecheck

# Run frontend tests
pnpm test

# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml
```

The frontend-only development server does not provide the native functionality normally supplied by Tauri.

### Basic usage

1. Open an existing Markdown document or create a new document.
2. Choose between Read, Source, Split, and Visual editing modes.
3. Use **Files → Open folder…** to open a workspace.
4. Access document tools for image pasting, link validation, and frontmatter visibility.
5. Open the command palette with **Cmd+Shift+P**.
6. Export documents using **Cmd+Shift+E**.
7. Use **Preferences…** to configure typography, appearance, spelling, and the default opening mode.

See the [User Guide](docs/user-guide.md) for detailed usage information.

---

## Technology stack

Marquellium is a desktop application built using a Rust backend and a React/TypeScript frontend.

| Component | Technology |
|---|---|
| Desktop framework | Tauri |
| Native backend | Rust |
| Frontend framework | React |
| Frontend language | TypeScript |
| Build tooling | Vite |
| Markdown rendering | Markdown rendering pipeline with Mermaid and KaTeX support |
| Frontend testing | Vitest |
| Backend testing | Rust test framework |
| Continuous integration | GitHub Actions |

### Repository structure

```text
marquellium/
├── .github/
│   └── workflows/       Continuous integration workflows
│
├── src/
│   ├── core/            Document engine and source mapping
│   ├── app/             Application state and composition
│   ├── components/      User interface components
│   ├── features/        Editing, preview, workspace, export
│   ├── services/        Tauri command integration
│   └── styles/          Application themes and print styles
│
├── src-tauri/           Rust backend and native integration
├── fixtures/            Test fixtures and validation data
├── docs/                Architecture and engineering documentation
├── LICENSE              MIT License
└── README.md            Project documentation
```

---

## Architecture and engineering

Marquellium is designed around a fundamental principle: **the Markdown source is authoritative**.

Visual editing is implemented using localized document transactions and source-range mapping. This approach minimizes changes to unrelated content and helps preserve formatting, whitespace, and unsupported constructs.

Architectural priorities include:

- **Separation of concerns** between the document engine, application state, presentation, and native services.
- **Document durability** through persistence, recovery, and safe-close handling.
- **Consistent editing state** across multiple tabs, windows, and editor modes.
- **Source-preserving transformations** wherever supported.
- **Least-privilege filesystem access** through controlled native commands.
- **Security-conscious rendering** and validation of potentially unsafe content.
- **Automated validation** of document round trips and editing behavior.

### Engineering documentation

The repository includes detailed documentation describing requirements, architecture, testing, and design decisions:

- [Product Requirements Document](docs/prd.md)
- [System Architecture](docs/architecture.md)
- [Threat Model](docs/threat-model.md)
- [Test Plan](docs/test-plan.md)
- [Requirements Mapping](docs/requirement-map.md)
- [Architecture Decision Records](docs/adr/)
- [Release Validation Matrix](docs/release-matrix.md)

These documents provide the technical foundation for Marquellium's implementation.

### Testing and continuous integration

GitHub Actions automates key validation tasks, including:

- TypeScript type checking.
- Frontend unit testing.
- Frontend production builds.
- Rust unit and integration testing.
- Clippy static analysis.
- Dependency security auditing.

See the [CI workflow](.github/workflows/ci.yml) for the configured checks.

Native desktop acceptance tests and platform-specific validation are tracked separately from automated unit testing.

---

## Contributing

Marquellium is an open-source project, and contributions, suggestions, and issue reports are welcome.

You can participate through the repository's GitHub features:

- [Issues](https://github.com/dodSONSoftware/marquellium/issues) — Report problems or suggest improvements.
- [Pull Requests](https://github.com/dodSONSoftware/marquellium/pulls) — Propose code or documentation changes.

Before contributing, review the architecture and engineering documentation to understand the project's design principles.

Changes affecting document editing or persistence should preserve Markdown source fidelity and include appropriate automated tests.

---

## License

Marquellium's source code is available under the **MIT License**.

Copyright © 2026 Randy Dodson, publishing under the name dodson labs.

See the [LICENSE](LICENSE) file for the complete license terms.

---

## About dodson labs

**dodson labs** is an independent open-source software publishing identity operated by Randy Dodson.

The goal of dodson labs is to develop and publish useful, thoughtfully engineered software with an emphasis on reliability, maintainability, and open development.

Marquellium is developed and published under the **dodson labs** name, with copyright ownership retained by Randy Dodson.
