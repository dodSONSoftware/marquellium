# Marquellium release acceptance follow up

This follow up completes the available keyboard accessibility fixes and expands native Linux acceptance beyond the committed checkpoint `371fb1d`. M3V and M4 remain accepted on macOS; M5 release acceptance and M6 platform acceptance remain open for the specific gates below. These changes are local and uncommitted. No release has been published.

## Completed changes

- Document tabs now expose named tab selection, unsaved state and separate close controls. Left/Right/Home/End move focus; Enter/Space activate through the existing draft navigation coordinator. Delete requests coordinated closing. Drag reordering remains available.
- Sidebar and Split dividers are keyboard focusable, expose their current range, and resize with arrows and Home/End. Pointer resizing remains available.
- Command palette search exposes combobox semantics and its active option.
- Debian packages now depend on `xdg-desktop-portal` and `xdg-desktop-portal-gtk`. The native dialog backend was missing from the minimal runtime. The rebuilt package includes those dependencies alongside GTK and WebKitGTK.
- The Linux acceptance harness now supports offline controls, actual GTK Quit keys, native save/print cancellation, real HTML/DOCX/PDF exports, syscall network traces and complete source-file SHA256 preservation checks. Native input is restricted to disposable Docker desktops and verifies target process/session ownership.

## Validation results

Evidence is in [release follow up validation](validation/2026-11-02/release-follow-up/). Historical manifests were retained; all **47** fixture/evidence entries selected from the M5 candidate manifest still match their original hashes.

| Check | Result and scope |
| --- | --- |
| Frontend suite | **503 passed**, 40 files, including five new focused tab/divider regression tests. Full suite also passed in the Linux builder. |
| TypeScript | `pnpm typecheck` passed. |
| macOS Rust | **107 passed, one ignored**, no failures. Clippy with warnings denied passed. |
| Bundled workers | Mapping, localized edits and table preservation checks passed against the built assets. |
| Packaging | Rebuilt macOS arm64 app, Debian arm64 package and aarch64 AppImage successfully. |
| Native macOS keyboard | Observed sidebar resize 240 to 250 pixels, Split resize 50 to 55 percent, and arrow focus followed by Enter tab activation. Focus movement alone left the selected document unchanged. This is targeted keyboard/AX acceptance, not full VoiceOver acceptance. |
| Installed Debian arm64 | **22 native checks passed**: Unicode/space paths, local image, KaTeX, Mermaid, HTML cancellation/export, DOCX export, print cancellation/PDF, shared document windows, process handoff, draft navigation/Cancel, desktop Open With, whole-file preservation and actual GTK Ctrl+Q/Cancel/retry/Discard. |
| AppImage | **16 native checks passed** offline, including shared windows, handoff, draft navigation, whole-file preservation and actual GTK Quit/Cancel. Executed with `APPIMAGE_EXTRACT_AND_RUN=1`; direct FUSE launch is not established. Export coverage in this run belongs to Debian. |
| Linux offline controls | Both IPv4 and IPv6 external socket controls returned network unreachable, with no external IPv4 routes. Core native checks passed in Docker `--network none`. |
| Network trace | Debian: 13,066 syscall lines, 155 INET destination records; AppImage: 6,665 lines, 83 records. **No non-loopback destination** appeared in traced connect/sendto/sendmsg calls for the driver and descendants. This is bounded process tracing, not host-wide packet capture or a universal no-telemetry claim. |
| Source preservation | Initial and final SHA256 match in both native runs. |
| PDF visual inspection | Actual GTK PDF rendered with Poppler: heading, blue local image, math, Start/Done diagram and table visible, without clipping. |
| DOCX independent inspection | ZIP CRC/XML checks passed. LibreOffice opened and rendered the DOCX; heading, image and table remained visible, with explicit math/Mermaid text fallbacks. Microsoft Word interoperability is still unverified. |

The export test initially used an invalid tiny PNG; LibreOffice detected its CRC error. The fixture now generates a valid RGBA PNG with correct chunk checksums, and final acceptance uses that image. Earlier automation iterations also corrected native filename selection and virtual-printer selection. Final results and original export artifacts are retained.

The macOS app remains open with disposable test documents. A user interaction was observed during native inspection; its unsaved text was retained. No user recovery records were cleared and no global network or screen-reader settings were changed. Disposable Docker acceptance containers were stopped after evidence collection.

## Remaining release gates

| Gate | What is still required |
| --- | --- |
| macOS distribution | A valid Developer ID Application identity and notarization profile, then signing/notarization/stapling and clean-account Gatekeeper/install/file-association acceptance. Current keychain reports **zero valid signing identities**. The existing signing script is available; no credentials were created or uploads attempted. |
| Windows | Native Windows build/installer, WebView2, file association, document lifecycle and print/export acceptance. No Windows host/VM or Git remote is configured here; prepared CI is not execution evidence. |
| Linux coverage | Native Wayland and other desktop environments, x64, direct AppImage/FUSE installation and the full persistent-recovery/edit/save acceptance matrix. Xvfb/Openbox arm64 results do not establish those environments. Portal parent-window warnings remain a desktop integration follow-up. |
| Accessibility | Full VoiceOver and Windows/Linux assistive-technology acceptance across editor, Visual drafts, Preferences, exports and dialogs. Keyboard fixes and AX observations are narrower evidence. |
| Performance | Cold filesystem-cache launch and physical input-to-pixel latency measurements on the documented baseline. Existing fresh-process/warm-cache benchmarks remain valid within their recorded scope. |
| macOS offline | A usable native macOS offline session and network-capture acceptance. The sandbox retry prevented a usable GUI session, so it remains inconclusive. Linux isolated-network acceptance does not close the macOS gate. |
| Export interoperability | Microsoft Word inspection and broader pagination/resource fixtures across platforms. DOCX LibreOffice rendering is supplemental evidence. |
| Final release review | Run dependency/security checks again for the exact distributable, resolve any findings, record the final license/branding decision, and approve distribution artifacts after the preceding gates. Existing audit evidence has not been refreshed or relabeled. |

The remaining gates require platform access, distribution credentials, or acceptance environments; they are not implemented by marking them passed. No broader rewrite or speculative feature work was added.

## Repeating the Linux checks

Use the acceptance Docker image/runtime with the rebuilt package, `tauri-driver`, WebKitWebDriver, Openbox, Xvfb, xdotool, strace, portals and Poppler installed. Run the container with `--network none`, then:

```sh
dbus-run-session -- xvfb-run -a python3 scripts/acceptance/m6-webdriver.py \
  /usr/bin/markdown-viewer --offline --native-keys --trace-network --exports \
  --output /tmp/marquellium-native-results
```

The test generates disposable Markdown, images and application data. A clean run records `status: passed`, all 22 checks and identical source hashes in `results.json`. Inspect the PDF/DOCX artifacts as well as automated assertions. AppImage testing uses the extracted-run environment and omits `--exports` unless those dialogs are being separately accepted.
