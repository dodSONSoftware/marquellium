import { AboutDialog } from "../features/about/AboutDialog";
import { applyDisplayScales } from "../features/settings/ui-scale";
import { ToolbarMenu } from "../features/layout/ToolbarMenu";
import logoLight from "../assets/branding/marquellium-logo-light.svg";
import logoDark from "../assets/branding/marquellium-logo-dark.svg";
import { ResizeHandle } from "../features/layout/ResizeHandle";
import { DocumentTabs } from "../features/documents/DocumentTabs";
import { useFileOpenRequests } from "../features/documents/useFileOpenRequests";
import { useBenchmark } from "../features/settings/useBenchmark";
import { ExportDialog } from "../features/export/ExportDialog";
import { Preferences, typographyDefaults } from "../features/settings/Preferences";
import { onSettingsChanged } from "../services/native";
import { useStatistics } from "../features/settings/useStatistics";
import { openSearchPanel } from "@codemirror/search";
import { imageInsertion } from "../core/image-insertion";
import { undo as undoDraft, redo as redoDraft } from "@codemirror/commands";
import { WorkspaceTree } from "../features/workspace/WorkspaceTree";
import { CommandPalette, type PaletteCommand } from "../features/commands/CommandPalette";
import { localLinks, hasAnchor } from "../core/local-links";
import { restoreContext } from "../core/view-context";
import { newTable } from "../core/table-edit";
import { type ViewContext } from "../core/view-context";
import { readerContext, restoreReaderContext, scrollReaderOffset } from "../features/reader/navigation";
import { VisualSurface, type PrototypeActivity } from "../features/visual/VisualSurface";
import { useLifecycle } from "../features/documents/useLifecycle";
import { openVisualPrototype } from "../services/native";
import { subscriptionScope } from "../services/subscription-scope";
/**
 * M1 shell: tabs, native menus, multiple windows, new/open/save/save-as,
 * dirty indicators, external-change handling, recovery prompt, and
 * close/quit resolution via the ADR-008 state machine.
 *
 * Read, CodeMirror Source, Split and source-preserving Visual share the
 * registry and the same coordinated navigation/draft lifecycle.
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
  type Trigger,
} from "../core/close-state-machine";
import { bytesToString } from "../core/ops";
import {
  DocumentStore,
  type LocalDoc,
} from "../features/documents/DocumentStore";
import { Reader } from "../features/reader/Reader";
import { runEditorCommand, sourceScrollOffset, scrollSourceOffset, sourceContext, restoreSourceContext, SourceEditor } from "../features/editor/SourceEditor";
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
  onDocumentSaved,
  onDragDrop,
  onMenuCommand,
  onWindowCloseRequested,
  type RecoveryInfo,
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
  defaultMode: "visual",
  spellcheckEnabled: true,
  uiScale: 100,
  documentScale: 100,
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
  { id: "visual", label: "Visual", available: true, note: "" },
];

/** FR-042: retain explicit stored modes; fresh/unknown defaults use Visual. */
function openMode(stored: string | undefined): ViewMode {
  return stored === "read" || stored === "source" || stored === "split" || stored === "visual"
    ? stored
    : "visual";
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
  history: (redo: boolean) => void;
  find: () => Promise<void>;
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
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState<string | null>(null);
  // FR-001: an OS file drag is hovering the window with openable files.
  const [dropActive, setDropActive] = useState(false);
  const [docState, setDocState] = useState<Map<string, LocalDoc>>(new Map());
  // FR-004: recent file paths, most-recent-first (restored at startup,
  // shown in the empty state, capped + de-duped on persist by Rust).
  const [recents, setRecents] = useState<string[]>([]);
  // Latest docState for the debounced session writer (avoid re-running it
  // on every store broadcast).
  const docStateRef = useRef(docState);
  // Set once the startup restore resolves, so the persistence writer never
  // clobbers the session file while a slow restore is still reading it.
  const restoredRef = useRef(false);
  const [startupReady, setStartupReady] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [recoveryLoaded, setRecoveryLoaded] = useState(false);
  // Latest derived session state, for the pagehide best-effort write.
  const sessionRef = useRef<SessionState | null>(null);
  const handlersRef = useRef<AppHandlers | null>(null);
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
  const viewContexts = useRef(new Map<string, ViewContext>());
  const [visualContext, setVisualContext] = useState<ViewContext | null>(null);
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
  useBenchmark(activeDoc ? docText(activeDoc) : "", readerContent, editorViewRef, () => store.flushAll());
  const readerEntry = useRef<{ docId: string; mode: ViewMode; scrollTop: number } | null>(null);
  const captureContext = useCallback(() => {
    if (!activeId || !activeDoc) return;
    const view = editorViewRef.current;
    if (view && (mode === "source" || mode === "split")) {
      viewContexts.current.set(activeId, sourceContext(view));
    } else if (mode === "read" && readerScrollRef.current) {
      const root = readerScrollRef.current;
      // Preserve an exact Source selection if Read has not moved. A scrolled
      // rendered view falls back to the visible block, never guessed offsets.
      if (!viewContexts.current.has(activeId) || readerEntry.current?.docId !== activeId ||
          Math.abs(root.scrollTop - readerEntry.current.scrollTop) > 1) {
        const context = readerContext(root, docText(activeDoc));
        if (context) viewContexts.current.set(activeId, context);
      }
    }
  }, [activeId, activeDoc, mode]);

  // --- UI preferences (FR-031 appearance, FR-047 sidebar) -------------------
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [preferences, setPreferences] = useState<Settings>(DEFAULT_SETTINGS);
  const statistics = useStatistics(activeDoc ? docText(activeDoc) : "");
  const [defaultMode, setDefaultMode] = useState<ViewMode>("visual");
  const [showFrontmatter, setShowFrontmatter] = useState(true);
  const [assetFolder, setAssetFolder] = useState("assets");
  const [linkResults, setLinkResults] = useState<string[] | null>(null);
  const [appearance, setAppearance] = useState<Appearance>("system");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarSection, setSidebarSection] = useState<"files" | "toc">("toc");
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const settingsRef = useRef<Settings | null>(null);
  const uiRef = useRef({ appearance, sidebarVisible, sidebarWidth, sidebarSection });
  uiRef.current = { appearance, sidebarVisible, sidebarWidth, sidebarSection };
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

  const pendingImports = useRef(0);
  const [importing, setImporting] = useState(false);
  const visualActivity = useRef<PrototypeActivity>({ draft: null, direct: null });
  const onVisualActivity = useCallback((activity: PrototypeActivity) => { visualActivity.current = activity; }, []);
  const lifecycle = useLifecycle(store, () => ({ ...visualActivity.current, opening: !!visualActivity.current.opening || pendingImports.current > 0 }), flash,
    () => restoredRef.current && (!modal || modal.kind === "disk"));
  const lifecycleRef = useRef(lifecycle);
  lifecycleRef.current = lifecycle;

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest?.("dialog")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && mode !== "source" && mode !== "split" && !lifecycleRef.current.blocked && !modal) {
        event.preventDefault(); void handlersRef.current?.find(); return;
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "p" && !lifecycleRef.current.blocked && !modal) {
        event.preventDefault(); captureContext(); setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [captureContext, modal, mode]);

  useEffect(() => { setLinkResults(null); }, [activeId, activeDoc?.revision]);

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
          // Explicit stored modes survive the fresh-default change.
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
          setPreferences(s);
          setDefaultMode(openMode(s.defaultMode));
          setShowFrontmatter(s.showFrontmatter !== false);
          setAppearance(s.appearance);
          setSidebarVisible(s.sidebar.visible);
          setSidebarSection(s.sidebar.section === "files" ? "files" : "toc");
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
        .catch(() => {}).finally(() => setSettingsLoaded(true));
      void native.recovery
        .list()
        .then((items) => {
          if (items.length > 0) setModal({ kind: "recovery", items });
        })
        .catch(() => {}).finally(() => setRecoveryLoaded(true));
      // FR-033: restore the previous session's file tabs (missing files
      // are skipped gracefully, FR-004). Restored before the persistence
      // writer is armed so it can't clobber the file mid-restore.
      void native.session
        .get()
        .then(restoreSession)
        .catch(() => {})
        .finally(() => {
          restoredRef.current = true;
          setStartupReady(true);
        });
    } else {
      try {
        const raw = localStorage.getItem(UI_LS_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          const loaded = { ...DEFAULT_SETTINGS, ...saved };
          settingsRef.current = loaded; setPreferences(loaded);
          const p = saved as {
            appearance?: Appearance;
            sidebarVisible?: boolean;
            sidebarWidth?: number;
            sidebarSection?: "files" | "toc";
          };
          setAppearance(p.appearance ?? "system");
          setSidebarVisible(p.sidebarVisible ?? true);
          setSidebarSection(p.sidebarSection ?? "toc");
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

  useEffect(() => {
    if (!isTauri()) return;
    const listener = onSettingsChanged((s) => {
      settingsRef.current = s; setPreferences(s); setAppearance(s.appearance);
      setDefaultMode(openMode(s.defaultMode)); setShowFrontmatter(s.showFrontmatter !== false);
      setSidebarVisible(s.sidebar.visible); setSidebarWidth(s.sidebar.width); setSidebarSection(s.sidebar.section);
    });
    return () => { void listener.then((off) => off()); };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.nativeSpelling = String(preferences.spellcheckEnabled);
    document.querySelectorAll(".cm-content").forEach((el) => el.setAttribute("spellcheck", String(preferences.spellcheckEnabled)));
    const p = { ...typographyDefaults, ...preferences }, style = document.documentElement.style;
    style.setProperty("--reader-font", ["system-ui", "serif", "sans-serif", "monospace", "ui-monospace"].includes(p.readerFont) ? p.readerFont : JSON.stringify(p.readerFont)); style.setProperty("--editor-font", ["monospace", "ui-monospace"].includes(p.editorFont) ? p.editorFont : JSON.stringify(p.editorFont));
    style.setProperty("--reader-font-size", `${p.fontSize}px`); style.setProperty("--editor-font-size", `${p.editorFontSize}px`);
    style.setProperty("--reader-line-height", String(p.lineSpacing / 100)); style.setProperty("--reader-max-width", `${p.maxWidth}px`);
  }, [preferences]);
  useEffect(() => {
    applyDisplayScales(preferences.uiScale, preferences.documentScale);
  }, [preferences.uiScale, preferences.documentScale]);
  const savePreferences = async (s: Settings) => {
    if (isTauri()) await native.settings.set(s); else localStorage.setItem(UI_LS_KEY, JSON.stringify(s));
    settingsRef.current = s; setPreferences(s); setAppearance(s.appearance); setDefaultMode(openMode(s.defaultMode)); setShowFrontmatter(s.showFrontmatter !== false);
    setSidebarVisible(s.sidebar.visible); setSidebarWidth(s.sidebar.width); setSidebarSection(s.sidebar.section);
  };

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
      sidebarSection?: "files" | "toc";
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
            section: patch.sidebarSection ?? base.sidebar.section,
            width: patch.sidebarWidth ?? base.sidebar.width,
          },
        };
        settingsRef.current = next;
        void native.settings.set(next).catch(() => {});
      } else {
        try {
          localStorage.setItem(
            UI_LS_KEY,
            JSON.stringify({ ...settingsRef.current, ...cur, ...patch }),
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
    subscriptions.add(onDocumentSaved(({ docId }) => {
      void store.refreshSavedDocument(docId).catch((error) => flash(`Save status refresh failed: ${error}`));
    }));
    subscriptions.add(onDocumentChangedOnDisk((event) => {
      void (async () => {
        const snapshot = await native.documents.snapshot(event.docId);
        const draft = await native.drafts.info(event.docId);
        if (event.autoReload && snapshot && !snapshot.dirty && !draft && !store.isDirty(event.docId) && !lifecycleRef.current.blocked) {
          await store.reloadFromDisk(event.docId);
          flash(`Reloaded ${event.docId.split(/[\\/]/).pop()} from disk`);
        } else { setModal({ kind: "disk", docId: event.docId }); }
      })().catch((error) => flash(`External change check failed: ${error}`));
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
      if (id === "preferences") { setPreferencesOpen(true); return; }
      if (id === "export") { window.dispatchEvent(new Event("app-export")); return; }
      if (id.startsWith("history:") && document.activeElement?.closest("dialog")) { document.execCommand(id === "history:redo" ? "redo" : "undo"); return; }
      if (id === "new") void h.newDocument();
      else if (id === "open") void h.openDocument();
      else if (id === "save") void h.saveActive();
      else if (id === "save_as") void h.saveAs();
      else if (id === "close_tab") h.closeActiveTab();
      else if (id === "quit") void native.quit().catch((err) => flash(`Quit failed: ${err}`));
      else if (id === "new_window") void openNewWindow().catch(() => {});
      else if (id === "find") void h.find();
      else if (id.startsWith("history:")) h.history(id === "history:redo");
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
    captureContext();
    // FR-042: new documents open in the configured default mode (a gated
    // mode such as Visual falls back to Source).
    const m = openMode(settingsRef.current?.defaultMode);
    setTabs((ts) =>
      ts.some((t) => t.docId === docId)
        ? ts
        : [...ts, { docId, mode: m }],
    );
    setActiveId(docId);
  }, [captureContext]);

  const newDocument = useCallback(async () => {
    if (lifecycleRef.current.blocked) return;
    if (activeId && !await lifecycleRef.current.begin("tab-switch", [activeId])) return;
    const id = await store.newDocument();
    addTab(id);
  }, [store, addTab, activeId]);

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
      if (lifecycleRef.current.blocked) return false;
      try {
        if (activeId && !await lifecycleRef.current.begin("tab-switch", [activeId])) return false;
        const id = await store.openDocument(path);
        addTab(id);
        setRecents((rs) => [path, ...rs.filter((p) => p !== path)]);
        return true;
      } catch (err) {
        flash(`Could not open: ${err}`);
        return false;
      }
    },
    [store, addTab, flash, activeId],
  );

  const fileOpen = useFileOpenRequests(startupReady && settingsLoaded && recoveryLoaded && !modal && !lifecycle.blocked, openPath, flash);

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
    if (pendingImports.current) { flash("An image import is still in progress."); return; }
    await visualActivity.current.direct?.settle();
    if (visualActivity.current.direct?.hasPending) { flash("Resolve pending Visual text before saving."); return; }
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
    if (pendingImports.current) { flash("An image import is still in progress."); return; }
    await visualActivity.current.direct?.settle();
    if (visualActivity.current.direct?.hasPending) { flash("Resolve pending Visual text before saving."); return; }
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

  const requestClose = useCallback((trigger: Trigger, onlyDocIds?: string[]) => {
    void (async () => {
      if (trigger === "quit") { await native.quit(); return; }
      if (!await lifecycleRef.current.begin(trigger, onlyDocIds ?? [])) return;
      if (trigger === "close-tab" && onlyDocIds) {
        for (const id of onlyDocIds) store.removeClosedDocument(id);
        setTabs((tabs) => tabs.filter((tab) => !onlyDocIds.includes(tab.docId)));
        setActiveId((id) => id && onlyDocIds.includes(id) ? null : id);
      }
    })().catch((error) => flash(String(error)));
  }, [store, flash]);

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
        void lifecycleRef.current.begin("mode-switch", [activeId]).then((allowed) => {
          if (!allowed) return;
          captureContext();
          if (mode === "visual") setVisualContext(viewContexts.current.get(activeId) ?? null);
          setTabs((ts) => ts.map((t) => (t.docId === activeId ? { ...t, mode } : t)));
        });
      }
    },
    [activeId, captureContext, flash],
  );

  // --- reader link handling (FR-023: relative to the containing doc) -------
  const openLocalFromReader = useCallback(
    async (relative: string, base: string | null) => {
      if (!base) {
        flash("Cannot resolve links in an unsaved document.");
        return;
      }
      const id = activeId;
      if (!id) return;
      try {
        const target = await native.workspace.link(id, relative);
        if (await openPath(target.path)) {
          if (target.fragment) window.setTimeout(() => document.getElementById(target.fragment!)?.scrollIntoView({ block: "start" }), 100);
        }
      } catch (error) { flash(`Could not open local link: ${error}`); }
    },
    [openPath, flash, activeId],
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

  const history = useCallback((redo: boolean) => {
    if (lifecycleRef.current.blocked || !activeId) return;
    const draft = visualActivity.current.draft;
    if (draft && !draft.closed) {
      (redo ? redoDraft : undoDraft)({ state: draft.state, dispatch: (transaction) => draft.dispatch(transaction) });
      return;
    }
    void (async () => {
      await visualActivity.current.direct?.settle();
      if (visualActivity.current.direct?.hasPending) return;
      await (redo ? store.redo(activeId) : store.undo(activeId));
    })().catch((error) => flash(String(error)));
  }, [activeId, store, flash]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest?.("dialog")) return;
      if (mode !== "visual" && mode !== "read" || paletteOpen || modal || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      if ((event.target as HTMLElement).closest('[aria-label="Inline source draft"]')) return;
      event.preventDefault(); history(event.shiftKey);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [mode, paletteOpen, modal, history]);

  const findInSource = useCallback(async () => {
    if (!activeId || lifecycleRef.current.blocked || !await lifecycleRef.current.begin("mode-switch", [activeId])) return;
    captureContext();
    setTabs((tabs) => tabs.map((tab) => tab.docId === activeId ? { ...tab, mode: "source" } : tab));
    requestAnimationFrame(() => {
      const view = editorViewRef.current;
      if (activeIdRef.current === activeId && view && !view.dom.closest(".pane-hidden")) { view.requestMeasure(); openSearchPanel(view); }
    });
  }, [activeId, captureContext]);

  handlersRef.current = {
    newDocument,
    openDocument,
    openPath,
    saveActive,
    saveAs,
    closeActiveTab,
    requestClose,
    setMode,
    history,
    find: findInSource,
  };

  // --- render -----------------------------------------------------------------
  const title = activeDoc
    ? `${activeDoc.dirty ? "● " : ""}${docName(activeDoc)} — Marquellium`
    : "Marquellium";

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
      const view = editorViewRef.current;
      view?.requestMeasure();
      const context = activeId ? viewContexts.current.get(activeId) : null;
      if (view && context) {
        restoreSourceContext(view, context);
      }
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

  useEffect(() => {
    if (mode !== "read" && mode !== "split" || !activeId) return;
    const previous = readerEntry.current;
    // Content updates in Split must not repeatedly snap the preview back to
    // an old selection. Restore once on entry, after its content is current.
    if (previous?.docId === activeId && previous.mode === mode) return;
    if (readerContent !== activeContent) return;
    const root = readerScrollRef.current;
    if (!root) return;
    const context = viewContexts.current.get(activeId);
    if (context) restoreReaderContext(root, context, activeContent);
    readerEntry.current = { docId: activeId, mode, scrollTop: root.scrollTop };
  }, [mode, activeId, readerContent, activeContent]);

  useEffect(() => {
    if (mode !== "read" && mode !== "split") readerEntry.current = null;
  }, [mode]);

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

  // Map actual source block positions, never the relative heights of unlike panes.
  useEffect(() => {
    if (mode !== "split" || !splitSync || readerContent !== activeContent) return;
    const view = editorViewRef.current, rd = readerScrollRef.current;
    if (!view || !rd) return;
    const ed = view.scrollDOM;
    let locked = false, frame = 0;
    const sync = (action: () => void) => {
      if (locked) return;
      locked = true; action();
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { locked = false; }); });
    };
    const onEdScroll = () => sync(() => scrollReaderOffset(rd, sourceScrollOffset(view), activeContent.length));
    const onRdScroll = () => sync(() => { const context = readerContext(rd, activeContent); if (context) scrollSourceOffset(view, context.anchor); });
    ed.addEventListener("scroll", onEdScroll, { passive: true });
    rd.addEventListener("scroll", onRdScroll, { passive: true });
    onEdScroll();
    return () => { cancelAnimationFrame(frame); ed.removeEventListener("scroll", onEdScroll); rd.removeEventListener("scroll", onRdScroll); };
  }, [mode, splitSync, activeDoc?.docId, readerContent, activeContent]);

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

  const insertMarkdown = async (markdown: string) => {
    if (!activeId || lifecycleRef.current.blocked || !await lifecycleRef.current.begin("mode-switch", [activeId])) return;
    captureContext();
    const fresh = await store.captureSourceSnapshot(activeId);
    const context = viewContexts.current.get(activeId);
    const position = context ? restoreContext(context, fresh.text) : { anchor: fresh.text.length, head: fresh.text.length };
    // Authorize exactly the captured selection, not an enclosing document rewrite.
    const from = Math.min(position.anchor, position.head) as import("../core/source-map").Utf16Offset;
    const to = Math.max(position.anchor, position.head) as typeof from;
    const range = { docId: fresh.docId, revision: fresh.revision, from, to };
    await store.applyLocalizedEdit({ docId: fresh.docId, baseRevision: fresh.revision, authorizedRange: range, range, openingText: fresh.text.slice(from, to), replacementText: markdown });
  };
  const pasteImage = async () => {
    if (!activeId || !activeDoc?.path || lifecycleRef.current.blocked || pendingImports.current) { flash("Save the document and finish the current edit before pasting an image."); return; }
    if (!await lifecycleRef.current.begin("mode-switch", [activeId])) return;
    pendingImports.current++;
    setImporting(true);
    try {
      captureContext();
      const id = activeId;
      const fresh = await store.captureSourceSnapshot(id);
      const context = viewContexts.current.get(id);
      const path = await native.assets.pasteImage(id, assetFolder);
      try { await store.applyLocalizedEdit(imageInsertion(fresh, context, path)); }
      catch (error) { throw new Error(`Image retained at ${path}; insertion could not be confirmed: ${error}`); }
    } finally { pendingImports.current--; setImporting(false); }
  };
  const checkLinks = async () => {
    if (!activeId) return;
    const fresh = await store.captureSourceSnapshot(activeId);
    const problems: string[] = [];
    for (const href of localLinks(fresh.text)) {
      try {
        if (href.startsWith("#")) { if (!hasAnchor(fresh.text, decodeURIComponent(href.slice(1)))) problems.push(`${href}: missing anchor`); }
        else {
          const target = await native.workspace.link(fresh.docId, href, true);
          if (target.fragment && target.content !== null && !hasAnchor(target.path === activeDoc?.path ? fresh.text : target.content, target.fragment)) problems.push(`${href}: missing anchor`);
        }
      } catch (error) { problems.push(`${href}: ${error}`); }
    }
    if (activeIdRef.current !== fresh.docId || docStateRef.current.get(fresh.docId)?.revision !== fresh.revision) { flash("Document changed; run link validation again."); return; }
    setLinkResults(problems.length ? problems : ["All checked local files and anchors are available. No external links were fetched."]);
  };
  const openExport = async () => { if (activeId && await lifecycleRef.current.begin("mode-switch", [activeId])) setExportOpen(true); };
  useEffect(() => { const open = () => { void openExport().catch((e) => flash(String(e))); }; window.addEventListener("app-export", open); return () => window.removeEventListener("app-export", open); });
  const commands: PaletteCommand[] = [
    { id: "preferences", label: "Preferences", run: () => setPreferencesOpen(true) },
    { id: "export", label: "Export HTML / PDF / DOCX", disabled: !activeId, run: () => void openExport().catch((e) => flash(String(e))) },
    { id: "new", label: "New document", run: () => void newDocument() },
    { id: "open", label: "Open document", run: () => void openDocument() },
    { id: "save", label: "Save document", disabled: !activeId, run: () => void saveActive() },
    ...MODES.map((m) => ({ id: `mode-${m.id}`, label: `Switch to ${m.label}`, disabled: !activeId, run: () => setMode(m.id) })),
    ...EDIT_COMMANDS.map((c) => ({ id: c.cmd, label: c.title, disabled: !activeId || mode === "read", run: () => { if (mode === "visual") window.dispatchEvent(new CustomEvent("visual-command", { detail: c.cmd })); else runEditorCommand(editorViewRef.current, c.cmd); } })),
    { id: "find", label: "Find / replace in Source", disabled: !activeId, run: () => void findInSource() },
    { id: "table", label: "Insert table", disabled: !activeId, run: () => void insertMarkdown("\n\n" + newTable + "\n\n").catch((e) => flash(String(e))) },
    { id: "image", label: "Paste clipboard image", disabled: !activeId, run: () => void pasteImage().catch((e) => flash(String(e))) },
    { id: "links", label: "Validate local links", disabled: !activeId, run: () => void checkLinks().catch((e) => flash(String(e))) },
    { id: "sidebar", label: "Toggle sidebar", run: () => toggleSidebar(!sidebarVisible) },
  ];

  const formattingButtons = EDIT_COMMANDS.map((c) => (
    <button
      key={c.cmd}
      className="fmt"
      title={c.title}
      disabled={!activeDoc || mode === "read" || lifecycle.blocked}
      onClick={() => {
        if (mode === "visual") { window.dispatchEvent(new CustomEvent("visual-command", { detail: c.cmd })); return; }
        runEditorCommand(editorViewRef.current, c.cmd);
        // Toolbar clicks steal focus from the CM view; hand it back
        // so typing continues where the user left off.
        editorViewRef.current?.focus();
      }}
    >
      {c.label}
    </button>
  ));

  return (
    <><div spellCheck={preferences.spellcheckEnabled} inert={lifecycle.blocked || importing} className="app" onPasteCapture={(event) => {
      if (mode === "read" || ![...event.clipboardData.items].some((item) => item.type.startsWith("image/"))) return;
      event.preventDefault(); void pasteImage().catch((error) => flash(String(error)));
    }}>
      {fileOpen.pending && <p role="status">File opening paused: {fileOpen.pending.path ?? fileOpen.pending.error}<button onClick={fileOpen.retry}>Retry opening</button><button onClick={() => void fileOpen.dismiss()}>Dismiss request</button></p>}
      {importing && <p role="status">Importing clipboard image…</p>}
      {aboutOpen && <AboutDialog theme={effectiveTheme} suspended={lifecycle.blocked} onClose={() => setAboutOpen(false)} onOpenExternal={openExternal} />}
      {preferencesOpen && <Preferences suspended={lifecycle.blocked} settings={{ ...(settingsRef.current ?? DEFAULT_SETTINGS), appearance, showFrontmatter, defaultMode }} onSave={savePreferences} onClose={() => setPreferencesOpen(false)} />}
      {exportOpen && activeId && <ExportDialog suspended={lifecycle.blocked} docId={activeId} title={activeDoc ? docName(activeDoc) : "Document"} snapshot={async () => (await store.captureSourceSnapshot(activeId)).text} onClose={() => setExportOpen(false)} />}
      {paletteOpen && <CommandPalette commands={commands} onClose={() => { setPaletteOpen(false); }} />}
      {linkResults && <section role="dialog" aria-label="Link validation" className="link-results"><h2>Local link validation</h2>{linkResults.map((message, i) => <p key={i}>{message}</p>)}<button onClick={() => setLinkResults(null)}>Close link results</button></section>}
      <header className="command-deck toolbar" aria-label="Document commands">
        <button type="button" className="app-brand" aria-label="About Marquellium" title="About Marquellium" onClick={() => setAboutOpen(true)}><img src={effectiveTheme === "dark" ? logoDark : logoLight} alt="Marquellium" width={190} height={45} draggable={false} /></button>
        <div className="command-section" role="group" aria-label="Document">
          <span className="command-label">Document</span>
          <div className="command-controls">
        <button onClick={() => void newDocument()}>+ New</button>
        <button onClick={() => void openDocument()}>Open…</button>
        <button className="primary-action" onClick={() => void saveActive()} disabled={!activeDoc}>
          Save
        </button>
          <ToolbarMenu label="More document actions">
        <button onClick={() => void saveAs()} disabled={!activeDoc}>
          Save As…
        </button>
        <details className="recent-menu"><summary>Open Recent</summary><div className="recent-popup">
          {recents.length ? recents.map((path) => <button key={path} title={path} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); void openRecent(path); }}>{docName({ docId: "", path })}</button>) : <p>No recent documents</p>}
        </div></details>
        <button
          onClick={() => void openNewWindow().catch(() => {})}
          title="New window"
        >
          + Window
        </button>
        {import.meta.env.VITE_M3V_VISUAL_PROTOTYPE === "1" && <button disabled={!activeId} onClick={() => activeId && void openVisualPrototype(activeId).catch((error) => flash(String(error)))}>M3V prototype</button>}
          </ToolbarMenu>
          </div>
        </div>
        <div className="command-section" role="group" aria-label="Format">
          <span className="command-label">Format</span>
          <div className="command-controls">
            {formattingButtons.slice(0, 5)}
          <ToolbarMenu label="More formatting"><div className="format-overflow">
            {formattingButtons.slice(5)}
          </div></ToolbarMenu>
          </div>
        </div>
        <div className="deck-utilities">
          <button className="icon-btn settings-button" aria-label="Settings" title="Settings (Cmd+,)" onClick={() => setPreferencesOpen(true)}>⚙</button>
        <button disabled={lifecycle.blocked} onClick={() => { captureContext(); setPaletteOpen(true); }} title="Command palette (Cmd+Shift+P)">Commands…</button>
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
          <ToolbarMenu label="Application tools">

        <button onClick={() => setPreferencesOpen(true)}>Preferences…</button>
        <button disabled={!activeId} onClick={() => void openExport().catch((e) => flash(String(e)))}>Export…</button>
        <details><summary>Document tools</summary><button disabled={!activeId} onClick={() => void insertMarkdown("\n\n" + newTable + "\n\n").catch((e) => flash(String(e)))}>Insert table</button>
          <button disabled={!activeId} onClick={() => void checkLinks().catch((e) => flash(String(e)))}>Validate links</button>
          <label>Assets folder <input value={assetFolder} onChange={(e) => setAssetFolder(e.target.value)} /></label>
          <button disabled={!activeId} onClick={() => void pasteImage().catch((e) => flash(String(e)))}>Paste image</button>
          <label><input type="checkbox" checked={showFrontmatter} onChange={(e) => { setShowFrontmatter(e.target.checked); const next = { ...(settingsRef.current ?? DEFAULT_SETTINGS), showFrontmatter: e.target.checked }; settingsRef.current = next; if (isTauri()) void native.settings.set(next).catch((error) => flash(String(error))); }} />Show frontmatter</label>
          <label>Default opening mode <select value={defaultMode} onChange={(e) => {
            setDefaultMode(e.target.value as ViewMode);
            const next = { ...(settingsRef.current ?? DEFAULT_SETTINGS), defaultMode: e.target.value as ViewMode };
            settingsRef.current = next; if (isTauri()) void native.settings.set(next).catch((error) => flash(String(error))); else localStorage.setItem(UI_LS_KEY, JSON.stringify(next));
          }}>{MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
        </details>
          </ToolbarMenu>
        </div>
      </header>
      <DocumentTabs tabs={tabs.map((tab) => { const document = docState.get(tab.docId); return { docId: tab.docId, name: document ? docName(document) : tab.docId, dirty: document?.dirty ?? false }; })} activeId={activeId}
        onSelect={(id) => {
          if (activeId === id) return;
          void lifecycleRef.current.begin("tab-switch", activeId ? [activeId] : []).then((allowed) => {
            if (!allowed) return;
            captureContext(); setVisualContext(viewContexts.current.get(id) ?? null); setActiveId(id);
          });
        }} onClose={(id) => requestClose("close-tab", [id])} onNew={() => void newDocument()} onMove={moveTab} />
      <div className="view-strip toolbar" role="group" aria-label="Document view">
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
        <div className="view-modes" role="group" aria-label="View mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            aria-pressed={activeTab?.mode === m.id}
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
        </div><span className="toolbar-spacer" />
        <div className="history-controls" role="group" aria-label="Document history">
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
        </div>
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
            section={sidebarSection}
            onSectionChange={(section) => { setSidebarSection(section); persistUi({ sidebarSection: section }); }}
            files={<WorkspaceTree onOpen={(path) => { void openPath(path); }} />}
            onNavigate={(line) => {
              const breaks = [...activeContent.matchAll(/\r\n|\r|\n/g)];
              const previous = breaks[line - 2];
              const position = line <= 1 ? 0 : previous ? previous.index + previous[0].length : activeContent.length;
              const context = { text: activeContent, anchor: Math.max(0, position), head: Math.max(0, position) };
              if (activeId) viewContexts.current.set(activeId, context);
              if (mode === "visual") setVisualContext(context);
              else if (mode === "read") restoreReaderContext(readerScrollRef.current!, context, activeContent);
              else if (editorViewRef.current) restoreSourceContext(editorViewRef.current, context);
            }}
          />
        )}
        {activeDoc ? (
          // FR-012B/AT-102: editor and reader stay MOUNTED across mode
          // switches (CSS visibility, not unmount), so the CM cursor and the
          // reader scroll position survive by construction.
          <div className="panes" id="document-panel" role="tabpanel" aria-label={docName(activeDoc)} ref={panesRef}>
            {mode === "visual" && <VisualSurface key={activeDoc.docId} snapshot={{ docId: activeDoc.docId, revision: activeDoc.revision, text: activeContent }} docPath={activeDoc.path} onOpenLocal={readerOpenLocal} onOpenExternal={openExternal} store={store} onActivity={onVisualActivity} context={visualContext} onContext={(context) => viewContexts.current.set(activeDoc.docId, context)} beforeOpen={(docId) => lifecycleRef.current.begin("mode-switch", [docId])} />}
            <div
              className={
                "pane pane-source" + (mode === "read" || mode === "visual" ? " pane-hidden" : "")
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
                  spellcheck={preferences.spellcheckEnabled}
              />
            </div>
            {mode === "split" && (
              <ResizeHandle className="pane-divider" label="Resize split panes" value={dragPct ?? splitPct} min={20} max={80} step={5} unit="percent" onResize={setSplitPct} onPointerDown={startSplitDrag} />
            )}
            <div
              className={
                "pane pane-reader" + (mode === "source" || mode === "visual" ? " pane-hidden" : "")
              }
            >
              <Reader
                key={activeDoc.docId}
                content={readerContent}
                docPath={activeDoc.path}
                onOpenLocal={readerOpenLocal}
                onOpenExternal={openExternal}
                scrollRef={setReaderScrollEl}
                showFrontmatter={showFrontmatter}
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
          {activeDoc ? `${statistics.words} words · ${statistics.characters} chars · ~${statistics.minutes} min read` : ""} ·{" "}
          {isTauri() ? "Tauri" : "browser (no Rust core)"}
        </span>
      </div>

      {toast && <div role="status" className="toast">{toast}</div>}
      {dropActive && (
        <div className="drop-overlay" aria-hidden="true">
          <span>Drop to open</span>
        </div>
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
        <RecoveryDialog modal={modal} store={store} setModal={setModal} flash={flash} onRestored={addTab} />
      )}
    </div>{lifecycle.dialog}</>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

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
                  if (!await native.lifecycle.begin("reload-document", [modal.docId])) return;
                  await store.refreshSavedDocument(modal.docId);
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
  onRestored,
}: {
  modal: Extract<Modal, { kind: "recovery" }>;
  store: DocumentStore;
  setModal: (m: Modal) => void;
  flash: (m: string) => void;
  onRestored: (docId: string) => void;
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
                        await store.attachDocument(payload.docId);
                        onRestored(payload.docId);
                        if (payload.draftCopyId) {
                          await store.attachDocument(payload.draftCopyId);
                          onRestored(payload.draftCopyId);
                        }
                        recoveryDismissed.add(i.key);
                        if (payload.hasDraft) await openVisualPrototype(payload.docId);
                        flash(payload.conflicted ? "Recovered canonical and draft text as separate safe copies; the original file is unchanged." : "Recovered an untitled copy; the original file is unchanged.");
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
