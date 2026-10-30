import { subscriptionScope } from "../services/subscription-scope";
/**
 * M1 shell: tabs, native menus, multiple windows, new/open/save/save-as,
 * dirty indicators, external-change handling, recovery prompt, and
 * close/quit resolution via the ADR-008 state machine.
 *
 * Modes: Read (M2 pipeline) and Source (textarea) are live; Split is M3
 * and Visual is gated on M3V (FR-012B: four persistent, visible buttons).
 * The left sidebar (FR-047, pulled forward) hosts the outline in Read mode;
 * the toolbar carries the sidebar toggle and the light/dark switch (FR-031).
 *
 * Note: M1 edits commit one full-buffer transaction per keystroke through
 * the registry (undo = per-keystroke). M3 batches CodeMirror changes into
 * one transaction per edit group via the same op path (ADR-006/007).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  CloseCoordinator,
  type DocStateForClose,
  type Trigger,
} from "../core/close-state-machine";
import { bytesToString } from "../core/ops";
import {
  DocumentStore,
  type LocalDoc,
} from "../features/documents/DocumentStore";
import { Reader } from "../features/reader/Reader";
import { runEditorCommand, SourceEditor } from "../features/editor/SourceEditor";
import type { EditCommandId } from "../features/editor/edit-commands";
import type { EditorView } from "@codemirror/view";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  Sidebar,
} from "../features/sidebar/Sidebar";
import { outlineOf } from "../core/render/pipeline";
import {
  pickRestoredActive,
  sessionFromTabs,
} from "../features/documents/session";
import {
  isTauri,
  native,
  openNewWindow,
  onDocumentChangedOnDisk,
  onDocumentUpdated,
  onDragDrop,
  onMenuCommand,
  onWindowCloseRequested,
  type RecoveryInfo,
  type SaveResult,
  type SessionState,
  type Settings,
} from "../services/native";

type ViewMode = "read" | "source" | "split" | "visual";
type Appearance = "light" | "dark" | "system";

/**
 * UI preferences with a home in the Rust settings store (FR-031/FR-047).
 * Persisted to app-data settings.json under Tauri, localStorage otherwise
 * (browser development). `Settings` defaults mirror Rust's `Settings::default`.
 */
const UI_LS_KEY = "markdown-viewer-ui";
const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  appearance: "system",
  defaultMode: "source",
  spellcheckEnabled: true,
  sidebar: { visible: true, width: 240, section: "files" },
};

const MODES: {
  id: ViewMode;
  label: string;
  available: boolean;
  note: string;
}[] = [
  { id: "read", label: "Read", available: true, note: "" },
  { id: "source", label: "Source", available: true, note: "" },
  { id: "split", label: "Split", available: true, note: "" },
  { id: "visual", label: "Visual", available: false, note: "gated on M3V fidelity prototype" },
];

/** FR-042: the stored default may name a mode this build cannot show yet
 *  (Visual until M3V passes) — such tabs fall back to Source. */
function openMode(stored: string | undefined): ViewMode {
  return stored === "read" || stored === "source" || stored === "split"
    ? stored
    : "source";
}

/** FR-001 drop filter: markdown and UTF-8 plain text (mirrors the Open
 *  dialog's markdown filter plus plain text). */
const DROP_OK_RE = /\.(md|markdown|txt)$/i;

/** Formatting toolbar commands (FR-013), in order. */
const EDIT_COMMANDS: { cmd: EditCommandId; label: string; title: string }[] = [
  { cmd: "bold", label: "B", title: "Bold (Cmd+B)" },
  { cmd: "italic", label: "I", title: "Italic (Cmd+I)" },
  { cmd: "code", label: "</>", title: "Code (Cmd+E)" },
  { cmd: "link", label: "Link", title: "Link (Cmd+K)" },
  { cmd: "heading", label: "H", title: "Heading (Cmd+H)" },
  { cmd: "list", label: "•", title: "Bullet list (Cmd+Shift+8)" },
  { cmd: "orderedList", label: "1.", title: "Numbered list (Cmd+Shift+9)" },
  { cmd: "quote", label: "❝", title: "Quote (Cmd+Shift+0)" },
  { cmd: "fence", label: "```", title: "Code fence (Cmd+Shift+F)" },
  { cmd: "task", label: "☑", title: "Task item (Cmd+Shift+T)" },
];

interface Tab {
  docId: string;
  mode: ViewMode;
}

type Modal =
  | {
      kind: "close";
      trigger: Trigger;
      coordinator: CloseCoordinator;
      onDone: (aborted: boolean) => void;
    }
  | { kind: "disk"; docId: string; conflict?: boolean; message?: string }
  | { kind: "recovery"; items: RecoveryInfo[] }
  | null;

/** The action surface the once-registered event listeners dispatch through. */
interface AppHandlers {
  newDocument: () => Promise<void>;
  openDocument: () => Promise<void>;
  openPath: (path: string) => Promise<boolean>;
  saveActive: () => Promise<void>;
  saveAs: () => Promise<void>;
  closeActiveTab: () => void;
  requestClose: (trigger: Trigger, onlyDocIds?: string[]) => void;
  setMode: (mode: ViewMode) => void;
}

function docName(d: { docId: string; path: string | null }): string {
  if (!d.path) return "Untitled";
  return d.path.split(/[\\/]/).pop() ?? d.path;
}

function docText(d: LocalDoc): string {
  return bytesToString(d.bytes);
}

export function App() {
  const storeRef = useRef<DocumentStore | null>(null);
  if (!storeRef.current) storeRef.current = new DocumentStore();
  const store = storeRef.current;

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState<string | null>(null);
  // FR-001: an OS file drag is hovering the window with openable files.
  const [dropActive, setDropActive] = useState(false);
  const [docState, setDocState] = useState<Map<string, LocalDoc>>(new Map());
  // FR-004: recent file paths, most-recent-first (restored at startup,
  // shown in the empty state, capped + de-duped on persist by Rust).
  const [recents, setRecents] = useState<string[]>([]);
  // FR-004: index of the tab being drag-reordered (null when idle).
  const [dragTabIdx, setDragTabIdx] = useState<number | null>(null);
  // Latest docState for the debounced session writer (avoid re-running it
  // on every store broadcast).
  const docStateRef = useRef(docState);
  // Set once the startup restore resolves, so the persistence writer never
  // clobbers the session file while a slow restore is still reading it.
  const restoredRef = useRef(false);
  // Latest derived session state, for the pagehide best-effort write.
  const sessionRef = useRef<SessionState | null>(null);
  const handlersRef = useRef<AppHandlers | null>(null);
  const activeCloseRef = useRef<CloseCoordinator | null>(null);
  const activeDoc = activeId ? docState.get(activeId) : undefined;
  const activeTab = tabs.find((t) => t.docId === activeId);
  const mode = activeTab?.mode ?? null;

  // --- M3 editor/split state ------------------------------------------------
  // The CM view object (created by SourceEditor, keyed by docId).
  const editorViewRef = useRef<EditorView | null>(null);
  const setEditorView = useCallback((v: EditorView | null) => {
    editorViewRef.current = v;
  }, []);
  // Split panes: editor pane width as % of the panes container (in-session).
  const panesRef = useRef<HTMLDivElement | null>(null);
  const [splitPct, setSplitPct] = useState(50);
  const [dragPct, setDragPct] = useState<number | null>(null);
  // FR-016: bidirectional scroll sync in Split mode; disableable, default on.
  const [splitSync, setSplitSync] = useState(true);
  // Reader scroll container + active heading (FR-014).
  const readerScrollRef = useRef<HTMLDivElement | null>(null);
  const setReaderScrollEl = useCallback((el: HTMLDivElement | null) => {
    readerScrollRef.current = el;
  }, []);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  // Split-mode preview is debounced: re-rendering the pipeline per
  // keystroke on a large doc would blow the NFR-003 input budget.
  const [readerContent, setReaderContent] = useState("");
  const readerKeyRef = useRef("");

  // --- UI preferences (FR-031 appearance, FR-047 sidebar) -------------------
  const [appearance, setAppearance] = useState<Appearance>("system");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const settingsRef = useRef<Settings | null>(null);
  const uiRef = useRef({ appearance, sidebarVisible, sidebarWidth });
  uiRef.current = { appearance, sidebarVisible, sidebarWidth };
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  /** Effective (resolved) theme — drives the toggle icon. */
  const effectiveTheme: "light" | "dark" =
    appearance === "system" ? (systemDark ? "dark" : "light") : appearance;

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500);
  }, []);

  // --- document store subscription ----------------------------------------
  useEffect(
    () =>
      store.subscribe((docs) => {
        docStateRef.current = new Map(docs);
        setDocState(docStateRef.current);
      }),
    [store],
  );

  // --- startup: load persisted UI prefs + recovery prompt (FR-006) ----------
  /** FR-033: reopen the previous session's file tabs in order. Untitled
   *  docs were never session tabs (recovery owns their content); files
   *  that no longer exist are skipped without interrupting the rest
   *  (FR-004). If the user already opened something first, their tabs
   *  win — the session was saved anyway. */
  const restoreSession = useCallback(
    async (s: SessionState) => {
      setRecents(s.recentFiles);
      // FR-004: omit unavailable recent files gracefully. Existence is a
      // read-only Rust stat (ADR-005: the UI never touches the FS).
      if (s.recentFiles.length > 0) {
        void native.files
          .exist(s.recentFiles)
          .then((exists) => {
            const dead = new Set(
              s.recentFiles.filter((_, i) => !(exists[i] ?? false)),
            );
            if (dead.size > 0) setRecents((rs) => rs.filter((p) => !dead.has(p)));
          })
          .catch(() => {});
      }
      if (s.tabs.length === 0) return;
      const opened: { docId: string; mode: ViewMode; orig: number }[] = [];
      for (let i = 0; i < s.tabs.length; i++) {
        const t = s.tabs[i]!;
        try {
          const docId = await store.openDocument(t.path);
          // FR-042 fallback: a stored mode this build can't show (Visual
          // until M3V) falls back to Source.
          opened.push({ docId, mode: openMode(t.mode), orig: i });
        } catch {
          /* missing or unreadable: skip gracefully */
        }
      }
      if (opened.length === 0) return;
      const activeIdx = pickRestoredActive(
        s.activeIndex,
        opened.map((o) => o.orig),
      );
      const active = opened[activeIdx]!;
      setTabs((ts) =>
        ts.length > 0 ? ts : opened.map(({ docId, mode }) => ({ docId, mode })),
      );
      setActiveId((cur) => (cur !== null ? cur : active.docId));
    },
    [store],
  );

  useEffect(() => {
    if (isTauri()) {
      void native.settings
        .get()
        .then((s: Settings) => {
          settingsRef.current = s;
          setAppearance(s.appearance);
          setSidebarVisible(s.sidebar.visible);
          // A persisted 0/negative/absurd width must never render a
          // sliver panel (the Rust side normalizes too; this covers
          // browser-dev localStorage as well).
          const w = s.sidebar.width;
          setSidebarWidth(
            Number.isFinite(w) && w >= SIDEBAR_MIN_WIDTH && w <= SIDEBAR_MAX_WIDTH
              ? w
              : 240,
          );
        })
        .catch(() => {});
      void native.recovery
        .list()
        .then((items) => {
          if (items.length > 0) setModal((m) => m?.kind === "close" ? m : { kind: "recovery", items });
        })
        .catch(() => {});
      // FR-033: restore the previous session's file tabs (missing files
      // are skipped gracefully, FR-004). Restored before the persistence
      // writer is armed so it can't clobber the file mid-restore.
      void native.session
        .get()
        .then(restoreSession)
        .catch(() => {})
        .finally(() => {
          restoredRef.current = true;
        });
    } else {
      try {
        const raw = localStorage.getItem(UI_LS_KEY);
        if (raw) {
          const p = JSON.parse(raw) as {
            appearance?: Appearance;
            sidebarVisible?: boolean;
            sidebarWidth?: number;
          };
          setAppearance(p.appearance ?? "system");
          setSidebarVisible(p.sidebarVisible ?? true);
          setSidebarWidth(p.sidebarWidth ?? 240);
        }
      } catch {
        /* first run: defaults stand */
      }
    }
  }, []);

  // FR-033: persist tab set + active + recents, debounced. Paths are read
  // from docStateRef (kept fresh by the store subscription) so per-keystroke
  // broadcasts don't re-trigger the write; only tab/active/recents changes do.
  // Armed only after the startup restore resolves (restoredRef) so a slow
  // restore can't be clobbered by an early empty write.
  useEffect(() => {
    if (!isTauri() || !restoredRef.current) return;
    const state = sessionFromTabs(
      tabs,
      (id) => docStateRef.current.get(id)?.path ?? null,
      activeId,
      recents,
    );
    sessionRef.current = state;
    const timer = window.setTimeout(() => {
      void native.session.set(state).catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [tabs, activeId, recents]);

  // Best-effort immediate write on pagehide (the debounce may not have fired).
  useEffect(() => {
    if (!isTauri()) return;
    const onPageHide = () => {
      if (sessionRef.current)
        void native.session.set(sessionRef.current).catch(() => {});
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // Track the OS appearance so "system" follows live changes (FR-031).
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Apply the resolved theme. "system" removes the attribute entirely so the
  // CSS media query decides (an empty `data-theme=""` would still match the
  // `[data-theme]` selector and pin light tokens on dark systems).
  useEffect(() => {
    if (appearance === "system") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = appearance;
    }
  }, [appearance]);

  /** Persist UI prefs (Tauri settings store, else localStorage). */
  const persistUi = useCallback(
    (patch: {
      appearance?: Appearance;
      sidebarVisible?: boolean;
      sidebarWidth?: number;
    }) => {
      const cur = uiRef.current;
      if (isTauri()) {
        const base = settingsRef.current ?? DEFAULT_SETTINGS;
        const next: Settings = {
          ...base,
          appearance: patch.appearance ?? base.appearance,
          sidebar: {
            ...base.sidebar,
            visible: patch.sidebarVisible ?? base.sidebar.visible,
            width: patch.sidebarWidth ?? base.sidebar.width,
          },
        };
        settingsRef.current = next;
        void native.settings.set(next).catch(() => {});
      } else {
        try {
          localStorage.setItem(
            UI_LS_KEY,
            JSON.stringify({ ...cur, ...patch }),
          );
        } catch {
          /* best effort in dev */
        }
      }
    },
    [],
  );

  const toggleTheme = useCallback(() => {
    const next: Appearance = effectiveTheme === "dark" ? "light" : "dark";
    setAppearance(next);
    persistUi({ appearance: next });
  }, [effectiveTheme, persistUi]);

  const toggleSidebar = useCallback(
    (visible: boolean) => {
      setSidebarVisible(visible);
      persistUi({ sidebarVisible: visible });
    },
    [persistUi],
  );

  const commitSidebarWidth = useCallback(
    (width: number) => {
      setSidebarWidth(width);
      persistUi({ sidebarWidth: width });
    },
    [persistUi],
  );

  // --- event wiring ---------------------------------------------------------
  // Listeners register once; they dispatch through handlersRef so they
  // always see the latest callbacks (no stale activeId closures).
  useEffect(() => {
    if (!isTauri()) return;
    const subscriptions = subscriptionScope((err) => flash(`Native event registration failed: ${err}`));
    subscriptions.add(onDocumentUpdated((u) => store.applyUpdate(u)));
    subscriptions.add(onDocumentChangedOnDisk((e) => {
      if (e.autoReload && !store.isDirty(e.docId)) {
        void store
          .reloadFromDisk(e.docId)
          .then(() => flash(`Reloaded ${e.docId.split(/[\\/]/).pop()} from disk`))
          .catch((err) => flash(`Reload failed: ${err}`));
      } else {
        setModal((m) => m?.kind === "close" ? m : { kind: "disk", docId: e.docId });
      }
    }));
    subscriptions.add(onWindowCloseRequested(() => {
      handlersRef.current?.requestClose("close-window");
    }));
    // Native OS drag & drop (FR-001). Core consumes the drop before it
    // reaches the webview, so no DOM preventDefault is needed (and it
    // would break CodeMirror's text-drag). The enter/leave overlay only
    // tracks hovers that carry at least one openable file.
    subscriptions.add(onDragDrop((e) => {
      if (e.type === "enter") {
        setDropActive((e.paths ?? []).some((p) => DROP_OK_RE.test(p)));
        return;
      }
      if (e.type === "over") return;
      if (e.type === "leave") {
        setDropActive(false);
        return;
      }
      // drop
      setDropActive(false);
      const paths = e.paths ?? [];
      const ok = paths.filter((p) => DROP_OK_RE.test(p));
      const h = handlersRef.current;
      if (!h) return;
      for (const p of ok) void h.openPath(p);
      // FR-001: actionable error for the rest.
      if (ok.length < paths.length)
        flash("Only .md, .markdown, and .txt files can be opened.");
    }));
    subscriptions.add(onMenuCommand((id) => {
      const h = handlersRef.current;
      if (!h) return;
      if (id === "new") void h.newDocument();
      else if (id === "open") void h.openDocument();
      else if (id === "save") void h.saveActive();
      else if (id === "save_as") void h.saveAs();
      else if (id === "close_tab") h.closeActiveTab();
      else if (id === "quit") void native.quit().catch((err) => flash(`Quit failed: ${err}`));
      else if (id === "new_window") void openNewWindow().catch(() => {});
      else if (id.startsWith("mode:")) h.setMode(id.slice(5) as ViewMode);
    }));
    // Final recovery snapshot when the webview goes away (FR-006).
    const onPageHide = () => {
      // Commit any in-flight edit group before snapshotting, so recovery
      // never resurrects pre-keystroke text.
      void store.flushAll().catch(() => {});
      for (const d of store.list) {
        void native.documents.recoverySnapshot(d.docId, null).catch(() => {});
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      subscriptions.dispose();
      window.removeEventListener("pagehide", onPageHide);
      // Release this window's views; the registry keeps canonical state for
      // any other window (AT-117).
      for (const d of store.list) {
        void native.documents.release(d.docId).catch(() => {});
      }
    };
  }, [store, flash]);

  // --- actions ---------------------------------------------------------------
  const addTab = useCallback((docId: string) => {
    // FR-042: new documents open in the configured default mode (a gated
    // mode such as Visual falls back to Source).
    const m = openMode(settingsRef.current?.defaultMode);
    setTabs((ts) =>
      ts.some((t) => t.docId === docId)
        ? ts
        : [...ts, { docId, mode: m }],
    );
    setActiveId(docId);
  }, []);

  const newDocument = useCallback(async () => {
    const id = await store.newDocument();
    addTab(id);
  }, [store, addTab]);

  /** FR-004: drag-reorder a tab (no document state touched — order only). */
  const moveTab = useCallback((from: number, to: number) => {
    if (from === to) return;
    setTabs((ts) => {
      if (from < 0 || from >= ts.length || to < 0 || to >= ts.length) return ts;
      const next = [...ts];
      const [moved] = next.splice(from, 1);
      if (!moved) return ts;
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  /**
   * Open a document by filesystem path (dialog, drag & drop, recents,
   * reader links). Records the path in recents (FR-004) and reports
   * success so callers (the recent-files list) can prune entries that
   * no longer open.
   */
  const openPath = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        const id = await store.openDocument(path);
        addTab(id);
        setRecents((rs) => [path, ...rs.filter((p) => p !== path)]);
        return true;
      } catch (err) {
        flash(`Could not open: ${err}`);
        return false;
      }
    },
    [store, addTab, flash],
  );

  /** Recent-files list (empty state): a file that no longer exists is
   *  pruned from the list after the failed attempt (FR-004). */
  const openRecent = useCallback(
    async (path: string) => {
      const ok = await openPath(path);
      if (!ok) setRecents((rs) => rs.filter((p) => p !== path));
    },
    [openPath],
  );

  const openDocument = useCallback(async () => {
    const path = await native.dialogs.openMarkdown();
    if (!path) return;
    await openPath(path);
  }, [openPath]);

  const saveAs = useCallback(async () => {
    if (!activeId) return;
    const d = store.get(activeId);
    const name = d ? docName(d) : "untitled";
    const path = await native.dialogs.saveMarkdown(name === "Untitled" ? "untitled.md" : name);
    if (!path) return;
    const res = await store.saveAs(activeId, path);
    if (!res.ok) flash(`Save As failed: ${res.message ?? res.reason}`);
    else flash(`Saved as ${name}`);
  }, [activeId, store, flash]);

  const saveActive = useCallback(async () => {
    if (!activeId) return;
    const d = store.get(activeId);
    if (!d) return;
    if (!d.path) {
      await saveAs();
      return;
    }
    const res = await store.save(activeId);
    if (!res.ok) {
      if (res.reason === "conflict") {
        setModal({
          kind: "disk",
          docId: activeId,
          conflict: true,
          message:
            "The file changed on disk since it was opened. Saving would overwrite external changes.",
        });
      } else {
        flash(`Save failed: ${res.message ?? res.reason}`);
      }
    } else {
      flash(`Saved ${docName(d)}`);
    }
  }, [activeId, store, flash, saveAs]);

  /**
   * Close/quit resolution (ADR-008). Builds the coordinator from live doc
   * state; if anything needs the user, the modal drives it. A failed Save or
   * Discard leaves the coordinator on the same step (AT-106).
   */
  const requestClose = useCallback(
    (trigger: Trigger, onlyDocIds?: string[]) => {
      if (activeCloseRef.current) return;
      const docs = store
        .list
        .filter((d) => !onlyDocIds || onlyDocIds.includes(d.docId))
        .map((d): DocStateForClose => ({
          docId: d.docId,
          path: d.path,
          dirty: store.isDirty(d.docId),
          // Drafts exist from M3V onward; the machine already handles them.
          draft: "absent",
          draftValid: true,
        }));
      const coordinator = new CloseCoordinator(trigger, docs);
      activeCloseRef.current = coordinator;
      void native.closeTrace("coordinator-start").catch(() => {});
      let done = false;
      const finish = (aborted: boolean) => {
        if (done) return;
        done = true;
        activeCloseRef.current = null;
        void native.closeTrace(aborted ? "cancelled" : "resolved").catch(() => {});
        setModal((m) =>
          m?.kind === "close" && m.coordinator === coordinator ? null : m,
        );
        if (aborted) return;
        if (trigger === "close-tab" && onlyDocIds) {
          const ids = onlyDocIds;
          for (const id of ids) void store.dispose(id).catch(() => {});
          setTabs((ts) => ts.filter((t) => !ids.includes(t.docId)));
          setActiveId((cur) =>
            cur && ids.includes(cur) ? null : cur,
          );
        } else if (trigger === "close-window") {
          void native.confirmWindowClose().catch((err) => flash(`Close failed: ${err}`));
        } else if (trigger === "quit") {
          void native.quit().catch(() => {});
        }
      };
      if (!coordinator.needsResolution) {
        finish(false);
        return;
      }
      setModal({ kind: "close", trigger, coordinator, onDone: finish });
    },
    [store, flash],
  );

  // Re-activate the last remaining tab after a close-tab resolution.
  useEffect(() => {
    if (activeId !== null) return;
    const last = tabs[tabs.length - 1];
    if (last) setActiveId(last.docId);
  }, [tabs, activeId]);

  const closeActiveTab = useCallback(() => {
    if (activeId) requestClose("close-tab", [activeId]);
  }, [activeId, requestClose]);

  const setMode = useCallback(
    (mode: ViewMode) => {
      const m = MODES.find((x) => x.id === mode);
      if (!m?.available) {
        flash(`${m?.label ?? mode} mode: ${m?.note ?? "not yet available"}`);
        return;
      }
      if (activeId) {
        setTabs((ts) => ts.map((t) => (t.docId === activeId ? { ...t, mode } : t)));
      }
    },
    [activeId, flash],
  );

  // --- reader link handling (FR-023: relative to the containing doc) -------
  const openLocalFromReader = useCallback(
    async (relative: string, base: string | null) => {
      if (!base) {
        flash("Cannot resolve links in an unsaved document.");
        return;
      }
      const baseNoFile = base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "";
      const raw = (baseNoFile + relative).split("/");
      const segs: string[] = [];
      for (const s of raw) {
        if (s === "" || s === ".") continue;
        if (s === "..") segs.pop();
        else segs.push(s);
      }
      const abs = "/" + segs.join("/");
      // Reuse openPath so link navigations also land in recents (FR-004).
      void openPath(abs);
    },
    [openPath, flash],
  );

  const openExternal = useCallback(
    (url: string) => {
      if (isTauri()) {
        void native.openExternal(url).catch((err) => flash(`Could not open link: ${err}`));
      } else {
        window.open(url, "_blank", "noopener");
      }
    },
    [flash],
  );

  // Reader callbacks are per-active-document: relative refs resolve against
  // the containing document's directory (FR-023).
  const readerOpenLocal = useCallback(
    (relative: string) => {
      if (activeDoc) void openLocalFromReader(relative, activeDoc.path);
    },
    [activeDoc, openLocalFromReader],
  );

  const undo = useCallback(
    (docId: string) => void store.undo(docId).catch(() => flash("Undo failed")),
    [store, flash],
  );
  const redo = useCallback(
    (docId: string) => void store.redo(docId).catch(() => flash("Redo failed")),
    [store, flash],
  );

  handlersRef.current = {
    newDocument,
    openDocument,
    openPath,
    saveActive,
    saveAs,
    closeActiveTab,
    requestClose,
    setMode,
  };

  // --- render -----------------------------------------------------------------
  const title = activeDoc
    ? `${activeDoc.dirty ? "● " : ""}${docName(activeDoc)} — Markdown Viewer`
    : "Markdown Viewer";

  // Outline computed once per content change and shared by the sidebar and
  // the reader (DOM ids and TOC entries agree by construction,
  // FR-014/FR-047). Keyed on the content string so unrelated store updates
  // don't re-parse.
  const activeContent = activeDoc ? docText(activeDoc) : "";
  const outline = useMemo(() => outlineOf(activeContent), [activeContent]);

  useEffect(() => {
    document.title = title;
  }, [title]);

  // Re-measure the CM view when its pane becomes visible (a view created or
  // kept in a display:none container must recompute its viewport).
  useEffect(() => {
    if (mode === "source" || mode === "split") {
      editorViewRef.current?.requestMeasure();
    }
  }, [mode, activeId]);

  // Preview content: live everywhere except Split, where it is debounced so
  // a keystroke burst re-renders the pipeline at most once per pause.
  useEffect(() => {
    const key = `${activeDoc?.docId ?? ""}|${mode ?? ""}`;
    if (mode !== "split") {
      readerKeyRef.current = key;
      setReaderContent(activeContent);
      return;
    }
    if (readerKeyRef.current !== key) {
      // Entering split (or a new doc): show current content immediately.
      readerKeyRef.current = key;
      setReaderContent(activeContent);
      return;
    }
    const t = window.setTimeout(() => setReaderContent(activeContent), 200);
    return () => window.clearTimeout(t);
  }, [activeContent, mode, activeDoc?.docId]);

  // FR-014: highlight the outline entry for the heading at the top of the
  // reader. rAF-throttled; headings are collected once per outline change.
  useEffect(() => {
    const el = readerScrollRef.current;
    if (
      !el ||
      (mode !== "read" && mode !== "split") ||
      outline.length === 0
    ) {
      setActiveSlug(null);
      return;
    }
    const heads = outline
      .map((o) => ({
        slug: o.slug,
        el: el.querySelector<HTMLElement>(`[id="${CSS.escape(o.slug)}"]`),
      }))
      .filter((h): h is { slug: string; el: HTMLElement } => h.el !== null);
    if (heads.length === 0) {
      setActiveSlug(null);
      return;
    }
    let raf = 0;
    const update = () => {
      raf = 0;
      const top = el.getBoundingClientRect().top;
      let best: string | null = null;
      for (const h of heads) {
        // Headings are in document order: the last one above the threshold
        // is the active one.
        if (h.el.getBoundingClientRect().top - top <= 80) best = h.slug;
        else break;
      }
      setActiveSlug((cur) => (cur === best ? cur : best));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
    };
  }, [outline, mode, activeDoc?.docId]);

  // Commit the in-flight edit group when the window loses focus so another
  // window (or a relaunch) never sees a half-flushed document.
  useEffect(() => {
    const onBlur = () => {
      void store.flushAll().catch(() => {});
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [store]);

  // FR-016: proportional scroll sync between the two split panes.
  // Bidirectional with a re-entrancy flag so a programmatic scroll is
  // recognized and dropped — no oscillation (AT for FR-016).
  useEffect(() => {
    if (mode !== "split" || !splitSync) return;
    const ed = editorViewRef.current?.scrollDOM;
    const rd = readerScrollRef.current;
    if (!ed || !rd) return;
    let programmatic = false;
    const apply = (from: HTMLElement, to: HTMLElement) => {
      const max = from.scrollHeight - from.clientHeight;
      if (max <= 0) return;
      const f = from.scrollTop / max;
      programmatic = true;
      to.scrollTop = f * (to.scrollHeight - to.clientHeight);
    };
    const onEdScroll = () => {
      if (programmatic) { programmatic = false; return; }
      apply(ed, rd);
    };
    const onRdScroll = () => {
      if (programmatic) { programmatic = false; return; }
      apply(rd, ed);
    };
    ed.addEventListener("scroll", onEdScroll, { passive: true });
    rd.addEventListener("scroll", onRdScroll, { passive: true });
    // Turning sync on aligns the reader to the editor's position.
    apply(ed, rd);
    return () => {
      ed.removeEventListener("scroll", onEdScroll);
      rd.removeEventListener("scroll", onRdScroll);
    };
  }, [mode, splitSync, activeDoc?.docId]);

  // Split divider drag (in-session; no persistence for M3).
  const startSplitDrag = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    const panes = panesRef.current;
    if (!panes) return;
    const rect = panes.getBoundingClientRect();
    const pctAt = (x: number) =>
      Math.min(80, Math.max(20, ((x - rect.left) / rect.width) * 100));
    const move = (ev: PointerEvent) => setDragPct(pctAt(ev.clientX));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setSplitPct(pctAt(ev.clientX));
      setDragPct(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  return (
    <div className="app">
      <div className="tabbar">
        {tabs.map((t, i) => {
          const d = docState.get(t.docId);
          return (
            <div
              key={t.docId}
              className={
                "tab" +
                (t.docId === activeId ? " active" : "") +
                (d?.dirty ? " dirty" : "") +
                (dragTabIdx === i ? " dragging" : "")
              }
              onClick={() => setActiveId(t.docId)}
              draggable
              onDragStart={(e) => {
                setDragTabIdx(i);
                e.dataTransfer.effectAllowed = "move";
                // Required by some engines to begin a drag.
                e.dataTransfer.setData("text/plain", t.docId);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (dragTabIdx === null || dragTabIdx === i) return;
                e.dataTransfer.dropEffect = "move";
                moveTab(dragTabIdx, i);
                setDragTabIdx(i);
              }}
              onDrop={(e) => e.preventDefault()}
              onDragEnd={() => setDragTabIdx(null)}
            >
              <span className="tab-name">{d ? docName(d) : t.docId}</span>
              {d?.dirty && <span className="dot" aria-label="unsaved changes" />}
              <button
                className="tab-close"
                aria-label={`Close ${d ? docName(d) : t.docId}`}
                onClick={(e) => {
                  e.stopPropagation();
                  requestClose("close-tab", [t.docId]);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          className="tab-new"
          onClick={() => void newDocument()}
          aria-label="New document"
        >
          +
        </button>
      </div>

      <div className="toolbar">
        <button
          className={
            "icon-btn" + (sidebarVisible ? " active" : "")
          }
          aria-label={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
          title={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
          disabled={!activeDoc}
          onClick={() => toggleSidebar(!sidebarVisible)}
        >
          {/* left-panel glyph */}
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <rect
              x="1.5"
              y="2.5"
              width="13"
              height="11"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <line
              x1="6"
              y1="2.5"
              x2="6"
              y2="13.5"
              stroke="currentColor"
              strokeWidth="1.4"
            />
          </svg>
        </button>
        <button onClick={() => void newDocument()}>New</button>
        <button onClick={() => void openDocument()}>Open…</button>
        <button onClick={() => void saveActive()} disabled={!activeDoc}>
          Save
        </button>
        <button onClick={() => void saveAs()} disabled={!activeDoc}>
          Save As…
        </button>
        <span className="toolbar-sep" />
        {MODES.map((m) => (
          <button
            key={m.id}
            className={
              "mode" +
              (activeTab?.mode === m.id ? " active" : "") +
              (m.available ? "" : " disabled")
            }
            title={m.available ? m.label : `${m.label} — ${m.note}`}
            disabled={!m.available}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
        {mode === "split" && (
          <button
            className={"icon-btn" + (splitSync ? " active" : "")}
            aria-label={
              splitSync ? "Disable scroll sync" : "Enable scroll sync"
            }
            aria-pressed={splitSync}
            title={
              splitSync
                ? "Scroll sync on — panes scroll together"
                : "Scroll sync off — panes scroll independently"
            }
            onClick={() => setSplitSync((s) => !s)}
          >
            ⇅
          </button>
        )}
        <span className="toolbar-sep" />
        {EDIT_COMMANDS.map((c) => (
          <button
            key={c.cmd}
            className="fmt"
            title={c.title}
            disabled={!activeDoc || mode === "read"}
            onClick={() => {
              runEditorCommand(editorViewRef.current, c.cmd);
              // Toolbar clicks steal focus from the CM view; hand it back
              // so typing continues where the user left off.
              editorViewRef.current?.focus();
            }}
          >
            {c.label}
          </button>
        ))}
        <span className="toolbar-sep" />
        <button
          onClick={() => activeId && undo(activeId)}
          disabled={!activeId}
          title="Undo (Cmd+Z)"
        >
          ↩
        </button>
        <button
          onClick={() => activeId && redo(activeId)}
          disabled={!activeId}
          title="Redo (Shift+Cmd+Z)"
        >
          ↪
        </button>
        <span className="toolbar-sep" />
        <button
          onClick={() => void openNewWindow().catch(() => {})}
          title="New window"
        >
          + Window
        </button>
        <span className="toolbar-spacer" />
        <button
          className="icon-btn"
          aria-label={
            effectiveTheme === "dark"
              ? "Switch to light mode"
              : "Switch to dark mode"
          }
          title={
            effectiveTheme === "dark"
              ? "Switch to light mode"
              : "Switch to dark mode"
          }
          onClick={toggleTheme}
        >
          {effectiveTheme === "dark" ? (
            // sun — click to go light
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="3" fill="currentColor" />
              <g
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              >
                <line x1="8" y1="0.8" x2="8" y2="2.8" />
                <line x1="8" y1="13.2" x2="8" y2="15.2" />
                <line x1="0.8" y1="8" x2="2.8" y2="8" />
                <line x1="13.2" y1="8" x2="15.2" y2="8" />
                <line x1="2.9" y1="2.9" x2="4.3" y2="4.3" />
                <line x1="11.7" y1="11.7" x2="13.1" y2="13.1" />
                <line x1="13.1" y1="2.9" x2="11.7" y2="4.3" />
                <line x1="4.3" y1="11.7" x2="2.9" y2="13.1" />
              </g>
            </svg>
          ) : (
            // moon — click to go dark
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M13.6 9.8A5.8 5.8 0 0 1 6.2 2.4 5.9 5.9 0 1 0 13.6 9.8Z"
                fill="currentColor"
              />
            </svg>
          )}
        </button>
      </div>

      <div className="content">
        {activeDoc && sidebarVisible && (
          <Sidebar
            outline={outline}
            tocActive={mode === "read" || mode === "split"}
            activeSlug={activeSlug}
            width={sidebarWidth}
            onToggle={toggleSidebar}
            onResize={commitSidebarWidth}
          />
        )}
        {activeDoc ? (
          // FR-012B/AT-102: editor and reader stay MOUNTED across mode
          // switches (CSS visibility, not unmount), so the CM cursor and the
          // reader scroll position survive by construction.
          <div className="panes" ref={panesRef}>
            <div
              className={
                "pane pane-source" + (mode === "read" ? " pane-hidden" : "")
              }
              style={
                mode === "split"
                  ? { flex: `0 0 ${dragPct ?? splitPct}%` }
                  : undefined
              }
            >
              <SourceEditor
                key={activeDoc.docId}
                docId={activeDoc.docId}
                content={activeContent}
                store={store}
                onView={setEditorView}
              />
            </div>
            {mode === "split" && (
              <div
                className="pane-divider"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize split panes"
                onPointerDown={startSplitDrag}
              />
            )}
            <div
              className={
                "pane pane-reader" + (mode === "source" ? " pane-hidden" : "")
              }
            >
              <Reader
                key={activeDoc.docId}
                content={readerContent}
                docPath={activeDoc.path}
                onOpenLocal={readerOpenLocal}
                onOpenExternal={openExternal}
                scrollRef={setReaderScrollEl}
              />
            </div>
          </div>
        ) : (
          <div className="empty">
            <h2>No document open</h2>
            <p>
              <button onClick={() => void newDocument()}>New document</button> or{" "}
              <button onClick={() => void openDocument()}>Open…</button>
            </p>
            {/* FR-004: recent files; a dead entry prunes itself on click. */}
            {recents.length > 0 && (
              <div className="recents">
                <h3>Recent</h3>
                <ul>
                  {recents.map((p) => (
                    <li key={p}>
                      <button onClick={() => void openRecent(p)} title={p}>
                        {docName({ docId: "", path: p })}
                      </button>
                      <span className="recent-path">{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="statusbar">
        <span>{activeDoc ? docName(activeDoc) : "—"}</span>
        {activeDoc?.dirty && <span className="status-dirty">unsaved</span>}
        <span className="status-right">
          {activeDoc ? `${docText(activeDoc).length} chars` : ""} ·{" "}
          {isTauri() ? "Tauri" : "browser (no Rust core)"}
        </span>
      </div>

      {toast && <div className="toast">{toast}</div>}
      {dropActive && (
        <div className="drop-overlay" aria-hidden="true">
          <span>Drop to open</span>
        </div>
      )}
      {modal?.kind === "close" && (
        <CloseDialog modal={modal} store={store} setModal={setModal} flash={flash} />
      )}
      {modal?.kind === "disk" && (
        <DiskDialog
          modal={modal}
          store={store}
          setModal={setModal}
          flash={flash}
          docState={docState}
        />
      )}
      {modal?.kind === "recovery" && (
        <RecoveryDialog modal={modal} store={store} setModal={setModal} flash={flash} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/**
 * ADR-008 modal. Renders the coordinator's current step; after each user
 * choice the machine advances (or stays put, on failure) and this dialog
 * re-renders. When the machine reaches the execute step it fires onDone.
 */
function CloseDialog({
  modal,
  store,
  setModal,
  flash,
}: {
  modal: Extract<Modal, { kind: "close" }>;
  store: DocumentStore;
  setModal: (m: Modal) => void;
  flash: (m: string) => void;
}) {
  const coordinator = modal.coordinator;
  const [saving, setSaving] = useState(false);
  // The coordinator is mutated in place (pure bookkeeping by design); the
  // tick is what tells React a step changed.
  const [tick, force] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    if (coordinator.isAborted) modal.onDone(true);
    else if (coordinator.current?.kind === "execute") modal.onDone(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, coordinator, modal.onDone]);

  const step = coordinator.current;
  if (!step || coordinator.isAborted) return null;

  const cancel = () => {
    coordinator.cancel();
    modal.onDone(true);
    setModal(null);
  };

  if (step.kind === "draft") {
    // Drafts land in M3V; the machine already supports this branch.
    return (
      <Overlay>
        <div className="dialog">
          <h3>Unapplied draft in “{step.filename}”</h3>
          <div className="dialog-actions">
            <button
              onClick={() => {
                if (!coordinator.chooseDraft(step.docId!, "apply")) {
                  flash("Draft could not be applied (invalid).");
                }
                force();
              }}
            >
              Apply
            </button>
            <button
              onClick={() => {
                coordinator.chooseDraft(step.docId!, "discard");
                force();
              }}
            >
              Discard
            </button>
            <button onClick={cancel}>Cancel</button>
          </div>
        </div>
      </Overlay>
    );
  }

  // canonical step
  const heading =
    modal.trigger === "quit"
      ? "Quit with unsaved changes?"
      : modal.trigger === "close-window"
        ? "Close this window with unsaved changes?"
        : "Close this document with unsaved changes?";

  return (
    <Overlay>
      <div className="dialog">
        <h3>Unsaved changes in “{step.filename}”</h3>
        <p className="muted">{heading}</p>
        <div className="dialog-actions">
          <button
            disabled={saving}
            onClick={() =>
              void (async () => {
                setSaving(true);
                const d = store.get(step.docId!);
                let res: SaveResult;
                if (!d?.path) {
                  const name = d ? docName(d) : "untitled";
                  const path = await native.dialogs.saveMarkdown(
                    name === "Untitled" ? "untitled.md" : name,
                  );
                  if (!path) {
                    setSaving(false);
                    flash("Save dialog cancelled — choose Save, Discard, or Cancel.");
                    return;
                  }
                  res = await store.saveAs(step.docId!, path);
                } else {
                  res = await store.save(step.docId!);
                }
                if (res.ok) {
                  coordinator.chooseCanonical(step.docId!, "save");
                } else {
                  // Stay on this step: retry / discard / cancel. (AT-106)
                  coordinator.saveFailed(step.docId!);
                  flash(`Save failed: ${res.message ?? res.reason}`);
                }
                setSaving(false);
                force();
              })()
            }
          >
            Save
          </button>
          <button
            onClick={() => {
              coordinator.chooseCanonical(step.docId!, "discard");
              force();
            }}
          >
            Discard
          </button>
          <button onClick={cancel}>Cancel</button>
        </div>
      </div>
    </Overlay>
  );
}

/** External disk change (FR-005): auto-reload when clean, prompt when dirty. */
function DiskDialog({
  modal,
  store,
  setModal,
  flash,
  docState,
}: {
  modal: Extract<Modal, { kind: "disk" }>;
  store: DocumentStore;
  setModal: (m: Modal) => void;
  flash: (m: string) => void;
  docState: Map<string, LocalDoc>;
}) {
  const [busy, setBusy] = useState(false);
  const d = docState.get(modal.docId);
  const name = d ? docName(d) : modal.docId;
  return (
    <Overlay>
      <div className="dialog">
        <h3>{modal.conflict ? "Save conflict" : "File changed on disk"}</h3>
        <p>
          {modal.message ?? `“${name}” was modified outside the app while open.`}
        </p>
        <div className="dialog-actions">
          <button
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  await store.reloadFromDisk(modal.docId);
                  flash(`Reloaded ${name} from disk`);
                  setModal(null);
                } catch (err) {
                  flash(`Reload failed: ${err}`);
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            {modal.conflict ? "Load disk version (discard my edits)" : "Reload from disk"}
          </button>
          <button onClick={() => setModal(null)}>Keep my version</button>
        </div>
      </div>
    </Overlay>
  );
}

const recoveryDismissed = new Set<string>();

/** Crash-recovery prompt (FR-006, AT-103/104): opt-in, restore as untitled. */
function RecoveryDialog({
  modal,
  store,
  setModal,
  flash,
}: {
  modal: Extract<Modal, { kind: "recovery" }>;
  store: DocumentStore;
  setModal: (m: Modal) => void;
  flash: (m: string) => void;
}) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const remaining = modal.items.filter((i) => !recoveryDismissed.has(i.key));
  return (
    <Overlay>
      <div className="dialog">
        <h3>Recover unsaved documents?</h3>
        <p className="muted">
          Snapshots from a previous session were found. Restoring opens them as
          new (untitled) documents — files on disk are never touched.
        </p>
        {remaining.length > 0 ? (
          <ul className="recovery-list">
            {remaining.map((i) => (
              <li key={i.key}>
                <span className="muted">{i.path ?? "Untitled"}</span>
                <span className="muted">
                  {" "}
                  · {i.contentBytes} B · revision {i.revision}
                </span>
                <button
                  onClick={() =>
                    void (async () => {
                      try {
                        const payload = await native.recovery.restore(i.key);
                        const id = await store.newDocument();
                        const text = new TextDecoder().decode(
                          new Uint8Array(payload.bytes),
                        );
                        await store.editFullContent(id, text);
                        recoveryDismissed.add(i.key);
                        flash(
                          `Restored snapshot as Untitled (was ${i.path ?? "untitled"})`,
                        );
                      } catch (err) {
                        flash(`Restore failed: ${err}`);
                      }
                      force();
                    })()
                  }
                >
                  Restore
                </button>
                <button
                  onClick={() =>
                    void (async () => {
                      await native.recovery.discard(i.key);
                      recoveryDismissed.add(i.key);
                      force();
                    })()
                  }
                >
                  Discard
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">All snapshots handled.</p>
        )}
        <div className="dialog-actions">
          <button
            onClick={() =>
              void (async () => {
                for (const i of remaining) await native.recovery.discard(i.key);
                for (const i of remaining) recoveryDismissed.add(i.key);
                setModal(null);
              })()
            }
          >
            Discard all
          </button>
          {/* Leaving snapshots in place: the prompt returns on next launch. */}
          <button onClick={() => setModal(null)}>Continue without restoring</button>
        </div>
      </div>
    </Overlay>
  );
}

function Overlay({ children }: { children: ReactNode }) {
  return (
    <div className="overlay" role="dialog" aria-modal="true">
      {children}
    </div>
  );
}
