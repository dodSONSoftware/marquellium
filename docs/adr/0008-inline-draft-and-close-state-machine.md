# ADR-008: Inline draft lifecycle and the close/quit resolution state machine

**Status:** Accepted (M0, 2026-10-29)
**PRD trace:** §1A.3, §1A.4, §1B.3, §1B.5, FR-053/FR-054, AT-105–108, AT-110–112, §1A.5 (all)

## Context

Two nested "unsaved work" mechanisms must never lose data and never be resolved out of order: (a) an **inline source draft** (session-scoped, per document, at most one open per document at a time, including across windows); (b) **canonical unsaved changes** (document dirty state). Every exit path — mode switch, tab close, window close, document close/reload, app quit — must pass through both, in order, with explicit user resolution.

## 1. Inline draft session

States (per canonical document; registry tracks the flag, frontend owns the session object):

```
            open editor
 Absent ──────────────────► CleanDraft
   ▲                          │  user edits draft
   │    Cancel /              ▼
   │    Apply (changed)    ModifiedDraft
   │                          │
   │                          ├── Revert ──► ModifiedDraft (draft reset to snapshot;
   │                          │             Revert is an entry in draft undo)
   └──────────────────────────┘
```

- **Open:** capture `(openingSnapshot, sourceRange, baseRevision)` immutably; create isolated draft buffer + history. Registry marks `draft_active = true` (with session token). Direct table-cell edits are suppressed/deferred while `draft_active` covers that table (§1B.3).
- **Validation:** the draft is validated continuously (parse the construct: mermaid AST, table grammar, math, code fence well-formedness). While invalid: diagnostics shown, last *valid* preview retained, **Apply disabled**. Draft text may be anything; canonical is never touched.
- **Apply:** requires `valid && baseRevision == registry.revision && range current`. If the registry revision moved (concurrent edit from another window/mode), Apply is **blocked** with remediation (rebase the draft onto the new base if the range is untouched; otherwise force Discard/Cancel — never blind overwrite). Otherwise: commit the smallest safe source-range change as **one** transaction, mark dirty, close session, destroy draft history. Unchanged draft ⇒ close, no transaction (invariant I2).
- **Cancel:** discard draft, close, destroy history. No document transaction.
- **Revert:** draft ← snapshot, stay open, *within draft history* (§1A.3). Not a document operation.
- **One session per document (all windows):** opening a second editor while a modified draft exists ⇒ modal "Resolve current editor first (Apply / Discard / switch to it)". Opening while a *clean* draft exists ⇒ the clean session is simply closed (no data at risk).

## 2. Exit-path state machine (close/quit/reload/mode-switch coordinator)

Runs in the frontend app shell (one coordinator per window; asks the registry for cross-window facts). Each trigger enters the same machine:

```
TRIGGER ∈ { modeSwitch, closeTab, closeWindow, quitApp, reloadDocument }

S0 Introspect
   for each affected document (a document is affected if it is open in the
   window closing / in any window on quit):
     draft_active? registry.dirty? registry.stale_disk?
S1 Resolve drafts            (per document, sequential)
   ModifiedDraft → modal [Apply | Discard | Cancel <trigger>]
     Apply:   run draft Apply (may itself fail on staleness → stay, show remediation)
     Discard: run draft Cancel
     Cancel:  abort whole trigger; nothing changes
   CleanDraft  → close silently
S2 Resolve canonical state   (per document, sequential; only reached if S1 resolved)
   dirty → prompt [Save | Discard | Cancel <trigger>]
     Save:    revision-checked save (ADR-006/004). Failure ⇒ prompt kept open,
              data preserved, retry/discard offered. Never proceed to destroy.
     Discard: mark clean without writing (recovery snapshot cleaned).
     Cancel:  abort trigger.
   clean → proceed
S3 Execute trigger (mode switch / close / quit / reload)
   quit: S3 = close all windows; S0 ran across ALL windows' documents, so a
   document shown in 2 windows is prompted once (canonical ownership, §1B.5/AT-117)
```

Rules:
- **Order is always drafts → canonical**, matching AT-107 ("resolve draft first, then canonical unsaved state").
- No nested dialogs: S1 and S2 serialize documents one at a time; on quit with many documents, a summary sheet lists all affected docs and then steps through them (AT-106).
- **Mode switch** with clean/no drafts is instant (no modal) (§1A.4).
- **External reload** (watcher event) is a trigger: auto-reload only when `!dirty && !draft_active` (§1B.5, AT-108); otherwise the S1/S2 sequence runs with the reload semantics (reload/keep/save-copy choices, per FR-005).
- App *crash* bypasses prompts by design; the recovery snapshots (ADR-004) cover it. Unresolved draft content is included in the snapshot (its text is serialized into the snapshot metadata) so a modified draft is also recoverable — restoring it re-opens the inline editor in ModifiedDraft state. This exceeds the PRD's "to be decided" note (§1A.4) in the safe direction; documented here as the chosen behavior.
- A failed Save at any point leaves the document open, dirty, and its recovery snapshot fresh (NFR-004).

## 3. Registry support (M1)

Rust exposes, per doc: `draft_active` (set/cleared by the frontend with the session token), `dirty`, `disk_revision vs saved_revision` (stale detection), and a single `documents_snapshot_recovery` write path. The frontend coordinator is the *only* caller of destructive close paths; there is no registry API that closes a document without the coordinator.

## Test mapping

### macOS termination entry point (M3V acceptance follow-up, November 2, 2026)

Dock Quit must enter the coordinator before Cocoa terminates the process. In
the pinned Tao 0.37.2 runtime, `applicationWillTerminate:` only reports an exit
already underway; Dock Quit did not emit Tauri's preventable `ExitRequested`
callback in the packaged-app test. The application therefore installs an
`applicationShouldTerminate:` override on a no-ivar subclass of its existing
delegate. All other runtime delegate callbacks and instance layout are retained.
Installation fails closed if the delegate/subclass cannot be established.

The override returns `NSTerminateCancel` synchronously and starts the same
asynchronous Rust coordinator used by menu Quit. This returns AppKit to its
ordinary run loop so webviews can resolve drafts and canonical unsaved work.
Only successful resolution calls `AppHandle::exit`; Cancel or failure leaves the
app running. This follows AppKit's documented termination-veto semantics:
[Apple NSApplication termination](https://developer.apple.com/documentation/appkit/nsapplication/terminate(_:)?language=objc).

When a resolution prompt is needed, its owner window is unminimized, shown, and
focused before delivery. Failure is observable and the pending request is
removed; focus alone is insufficient for minimized macOS windows. Preparation
and internal draft-discard acknowledgements do not bring windows forward.

Content-free diagnostics record the native Quit source and each window's actual
focus-query result. These are acceptance evidence, not substitutes for invoking
the Dock menu. The macOS regression test checks the method ABI, identical
delegate layout, and inherited callback behavior; the packaged two-window
Dock/Cancel/retry test checks the OS integration.

| Test | Scenario |
|---|---|
| AT-105 | S2 Save/Discard/Cancel on tab/window close; Cancel leaves state intact |
| AT-106 | quit, multiple dirty docs, Cancel aborts; save failure keeps app open |
| AT-107 | draft + dirty: S1 before S2; no silent loss; accidental draft save impossible (Apply validates) |
| AT-108 | clean ⇒ auto-reload; dirty ⇒ prompt; stale save ⇒ conflict, no silent overwrite |
| AT-110/111/112 | draft Apply/Cancel/invalid-draft paths per §1 |
| §1A.5.6 | mode switch modal exactly Apply/Discard/Cancel-switch; none for clean drafts |
