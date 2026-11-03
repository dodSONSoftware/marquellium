# M6 — Windows/Linux portability

Date: November 2, 2026. Status: **partial delivery; milestone acceptance OPEN**.

M6 now has working Linux arm64 candidates and executed native tests, rather than a portability claim based on macOS compilation. Windows build/installer automation is prepared but has not run: this checkout has no Git remote, no `gh`, and no Windows host. Nothing was committed, pushed, published, or installed on the host's normal application/data paths.

## Implemented

- Markdown/text file associations in Tauri packaging; macOS rank is Alternate, without changing the user's default application.
- CLI paths and local `file:` URLs, including spaces and Unicode; relative arguments resolve against the sending process's working directory.
- Stable `tauri-plugin-single-instance` 2.5.5 forwards subsequent launches into the existing process. Acceptance data overrides use distinct instance identifiers so disposable tests cannot forward requests into a normal user session.
- macOS Open With events and Linux desktop entry integration. The initial generated Debian desktop entry omitted file arguments; the explicit template now includes `Exec=markdown-viewer %F`.
- A bounded, acknowledged file-open queue assigns each request to one document window. Startup requests wait for settings, session and recovery handling. Opening uses the existing draft/navigation coordinator. Cancel retains the request with Retry/Dismiss controls and preserves the draft. Requests transfer to a surviving document window if their owner closes.
- Unix/Windows local-media path handling, one-pass URI decoding, native protocol URL conversion, and an exact WebView2 local-media origin allowance. Lookalike hosts, explicit ports, malformed paths and implicit UNC media roots remain rejected; Rust still canonicalizes and checks filesystem scope.
- AppImage launch-directory preservation uses the runtime's `OWD`; when extract-and-run mode omits it, a verified parent-runtime executable supplies its original cwd before the single-instance plugin starts. Linux regressions cover valid/invalid original-directory selection and parent PID parsing.
- Platform menu guards omit unsupported Linux maximize and non-macOS Bring All to Front items. PDF instructions describe each platform's native PDF destination.
- Focused Rust/TypeScript regressions and a reusable native W3C WebDriver smoke runner. Linux runs use real WebKitGTK with Xvfb, Openbox and a private D-Bus session. No product test bridge or disabled webview sandbox was added.
- `.github/workflows/portability.yml` prepares macOS, Windows NSIS/MSI, and Ubuntu Debian/AppImage candidate builds, locked Rust validation, frontend validation and installed Debian smoke testing. It uploads candidate artifacts only; it does not publish releases. This workflow was **not dispatched** here.

No existing locked package version was removed or changed. Added packages are `tauri-plugin-single-instance` 2.5.5 and `libloading` 0.8.9. Rust formatting also normalized existing Rust modules in the already modified working tree; this is not additional feature scope.

## Validation

| Check | Executed result |
| --- | --- |
| macOS frontend typecheck and suite | PASS: 498 tests, 38 files |
| macOS Rust tests | PASS: 107 passed, 1 existing fixture test ignored |
| Debian arm64 frontend suite | PASS: 498 tests, 38 files |
| Debian arm64 Rust tests | PASS: 108 passed, 1 existing fixture test ignored |
| Clippy, all targets, warnings denied | PASS on macOS and Debian arm64 |
| Production frontend bundle and bundled-worker checks | PASS; existing large-chunk advisory remains |
| macOS arm64 `.app` | Built; final local file-URI launch and clean Command-Q verified through native UI |
| Debian arm64 `.deb` | PASS: built, installed and native suite passes 17 checks in a fresh Debian runtime-only container |
| Linux arm64 AppImage | PASS: built; native extract-and-run suite passes 16 checks; desktop entry contains `%F` |
| Existing M4 fixtures | All 30 fixture hashes preserved |
| Windows build/install/native behavior | NOT RUN |

The macOS native run also verified a cold CLI filename with spaces/Japanese text, second-process relative-path forwarding, only the focused window receiving new tabs, draft prompt Cancel preserving `11` while canonical content remained `10`, explicit Dismiss preserving the draft, draft Cancel restoring `10`, and an actual `open -a <candidate.app> <file>` event. The other document window retained only its original tab. Native Command-Q closed the clean session. Tests used `/private/tmp/marquellium-m6-macos` and isolated data directories.

The Linux installed-package suite checks cold opening, spaces/Unicode, local images, KaTeX, Mermaid, a second shared-document window, second-process routing, tab isolation, draft ownership/navigation, Cancel and Dismiss, unchanged fixture bytes, desktop Open With, coordinated Quit Cancel retaining both windows/draft, and subsequent Discard terminating the application process. Quit is invoked through the existing Rust `quit_app` command, the same coordinator entry used by native menus. **WebDriver's Ctrl-Q injection did not activate GTK menu accelerators, so native Linux menu/shortcut activation is unverified.** It is not reported as a passing accelerator test.

Environment: macOS 27.2 arm64; Debian 12 arm64 in Docker; Rust 1.99.1, Node 22.23.4, pnpm 12.16.1, GTK 3.24.38 and WebKitGTK 2.50.6. The Debian runtime container was created from `debian:bookworm-slim`, with the candidate plus runtime/test utilities; it has no project source, Node toolchain or Rust compiler. Builder and runtime image digests are in the evidence manifest.

Harness setup issues were corrected rather than weakening assertions: missing fixture subdirectories from an overly broad source-copy exclusion, default Visual heading input selectors, async draft initialization, the need for a window manager for focus, and `gio` as a desktop-launch test utility. Early failed logs are retained separately from final passing evidence. GTK's missing AT-SPI service warning means these runs do **not** establish accessibility acceptance. The minimal runtime font set lacks CJK glyphs in the screenshot; Unicode filenames route correctly at the document/DOM level, while multilingual font presentation remains a desktop acceptance check.

## Reproduce

Build the isolated Linux builder with `docker build -f scripts/acceptance/m6-linux.Dockerfile ...` using an empty build context containing that Dockerfile. Copy a disposable source snapshot, including all `fixtures/`, into `/work`; omit `.git`, credentials, host data, `node_modules`, build targets and unrelated evidence. Then run:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build:web
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
APPIMAGE_EXTRACT_AND_RUN=1 pnpm tauri build --bundles deb,appimage
```

Install the candidate in a disposable Debian environment with GTK/WebKitGTK and the test utilities `python3`, `xvfb`, `dbus-x11`, `xauth`, `openbox`, `libglib2.0-bin`, `webkit2gtk-driver`, and official `tauri-driver` 2.1.0. Run:

```sh
dbus-run-session -- xvfb-run -a python3 scripts/acceptance/m6-webdriver.py \
  /usr/bin/markdown-viewer --output /tmp/m6-native
```

The runner creates unique fixture/data directories. It does not modify existing documents or MIME defaults. Its screenshots, structured check list and driver logs belong with the candidate hashes. AppImage `APPIMAGE_EXTRACT_AND_RUN=1` avoids a FUSE requirement in containers; that does not verify direct FUSE launching on a desktop. The verified parent-runtime fallback handles this runtime mode's missing `OWD`. See the [AppImage runtime environment contract](https://docs.appimage.org/packaging-guide/environment-variables.html).

## Remaining acceptance gates

1. Execute the Windows x64 build/test/Clippy and NSIS/MSI jobs; install on a clean Windows machine, verify WebView2 provisioning, CLI/Explorer Open With, drive/case/long-path behavior, local images, clipboard, draft recovery, native Quit/Cancel and uninstall. Windows ARM64 is a separate, unclaimed target.
2. Execute native Linux menu/shortcut activation, native file/save dialogs, clipboard/spelling behavior and accessibility; verify on a supported desktop distribution/session (including Wayland). Debian arm64/X11 container results do not certify Ubuntu, other distributions, x64, or Wayland.
3. Complete Windows/Linux HTML/DOCX export and native print-to-PDF acceptance, including Cancel and output inspection. Shared automated export tests pass; that is not platform print evidence.
4. Test AppImage direct desktop/FUSE launch, integration and removal outside the container. Extract-and-run native launch is a narrower result.
5. Finish the full shared-document save/close/recovery matrix on Windows/Linux and platform performance/offline/security/accessibility acceptance. The focused M6 suite does not replace the full PRD smoke matrix.
6. M5 production signing/notarization and clean macOS release-install gates remain open, as already recorded in `m5-results.md` and `release.md`.

The next required environment is a Windows runner/host. Preparing CI does not close that gate, and no unrelated branch or remote was created to obtain one.

## Saved artifacts

- `validation/2026-11-02/m6-candidate-sha256.json`: final package/binary and relevant source/configuration hashes.
- `validation/2026-11-02/m6-debian-native/`: 17 passing checks, native screenshot, driver log and disposable launch environment.
- `validation/2026-11-02/m6-appimage-native/`: 16 passing checks from the packaged image in extract-and-run mode, screenshot and driver log.
- `validation/2026-11-02/m6-macos-native-observations.json`: explicitly labeled native UI observations.
- `validation/2026-11-02/m6-native-final.log`: final installed Debian and AppImage execution log.
- Local candidates: `src-tauri/target/m6-linux/Marquellium_0.1.0_arm64.deb`, `src-tauri/target/m6-linux/Marquellium_0.1.0_aarch64.AppImage`, and `src-tauri/target/release/bundle/macos/Marquellium.app`. Build outputs are ignored by Git.

Both disposable Docker containers were stopped after evidence collection. Docker Desktop was started for these tests and remains available; normal app data and document defaults were not changed.
