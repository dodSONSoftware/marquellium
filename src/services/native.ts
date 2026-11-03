import type { DraftLease, DraftOpening } from "../core/draft-session";
/**
 * Typed facade over the Rust command surface (ADR-005: the only path the UI
 * has to the filesystem). Falls back to a no-op surface in the browser so
 * the component tree can be developed without the Tauri runtime.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type NewlinePolicy = "lf" | "crlf" | "cr" | "none";

export interface DiskRevision {
  modifiedAtNs: string;
  sizeBytes: number;
  contentHash: string;
}

export interface DocumentSnapshot {
  docId: string;
  path: string | null;
  content: string;
  bom: boolean;
  newline: NewlinePolicy;
  revision: number;
  savedContentHash: string | null;
  savedDiskRevision: DiskRevision | null;
  diskRevision: DiskRevision | null;
  dirty: boolean;
  draftActive: string | null;
}

export interface DocOp {
  startByte: number;
  endByte: number;
  text: string;
}

export interface DocumentUpdate {
  docId: string;
  revision: number;
  ops: DocOp[];
  dirty: boolean;
  kind: "edit" | "undo" | "redo";
}

export interface SaveResult {
  ok: boolean;
  revision: DiskRevision | null;
  reason: "conflict" | "io-error" | "untitled" | null;
  message: string | null;
}

export interface RecoveryInfo {
  key: string;
  path: string | null;
  createdAt: number;
  contentBytes: number;
  revision: number;
  hasDraft: boolean;
}

export interface RecoveryPayload {
  docId: string;
  hasDraft: boolean;
  conflicted: boolean;
  draftCopyId: string | null;
}

export interface Settings {
  schemaVersion: number;
  appearance: "light" | "dark" | "system";
  defaultMode: "read" | "source" | "split" | "visual";
  spellcheckEnabled: boolean;
  showFrontmatter?: boolean;
  readerFont?: string; editorFont?: string; fontSize?: number; editorFontSize?: number; lineSpacing?: number; maxWidth?: number;
  sidebar: { visible: boolean; width: number; section: "files" | "toc" };
}

// FR-033/FR-004: restored tabs (file path + mode only — content never) and
// most-recent-first file history. Untitled docs are not session tabs; their
// content is covered by recovery snapshots (FR-006).
export interface SessionTab {
  path: string;
  mode: string;
}

export interface SessionState {
  schemaVersion: number;
  tabs: SessionTab[];
  activeIndex: number;
  recentFiles: string[];
}

// --- commands -------------------------------------------------------------

export interface WorkspaceSearchResults { matches: { path: string; line: number; preview: string }[]; skippedFiles: number; truncated: boolean }
export interface WorkspaceEntry { name: string; path: string; isDir: boolean; isSymlink: boolean; size: number }
export interface FileOpenRequest { id: number; path: string | null; error: string | null }
export const onFileOpenPending = (callback: () => void) =>
  listen("file-open-pending", callback, { target: { kind: "Window", label: getCurrentWindow().label } });
export const native = {
  fileOpen: {
    next: () => invoke<FileOpenRequest | null>("file_open_next"),
    ack: (id: number) => invoke<void>("file_open_ack", { id }),
  },
  export: {
    image: (docId: string, href: string) => invoke<string>("export_image", { docId, href }),
    save: (docId: string, format: "html" | "docx", html: string, blocks: import("../features/export/document").ExportBlock[]) => invoke<string | null>("export_save", { docId, format, html, blocks }),
    preview: (html: string) => invoke<void>("export_preview", { html }),
    previewContent: () => invoke<string>("export_preview_content"),
    print: () => invoke<void>("export_print"),
  },
  workspace: {
    root: () => invoke<string | null>("workspace_root"),
    search: (query: string, exclusions: string[]) => invoke<WorkspaceSearchResults>("workspace_search", { query, exclusions }),
    list: (root: string, exclusions: string[]) => invoke<WorkspaceEntry[]>("workspace_list_dir", { root, exclusions }),
    link: (docId: string, href: string, readContent = false) => invoke<{ path: string; fragment: string | null; content: string | null }>("workspace_link", { docId, href, readContent }),
  },
  assets: { pasteImage: (docId: string, folder: string) => invoke<string>("assets_paste_image", { docId, folder }) },
  lifecycle: {
    begin: (trigger: LifecycleTrigger, docIds: string[] = []) => invoke<boolean>("lifecycle_begin", { trigger, docIds }),
    reply: (id: number, value: unknown, error?: string) => invoke<void>("lifecycle_reply", { id, value, error: error ?? null }),
  },
  appInfo: () =>
    invoke<{ name: string; version: string; dataDir: string }>("app_info"),

  /**
   * Tell the Rust core this window's close state machine has resolved, then
   * close the window. Required because Rust intercepts every CloseRequested
   * and re-prompts otherwise (ADR-008, AT-108).
   */
  closeTrace: (stage: "coordinator-start" | "resolved" | "cancelled" | "requested") =>
    invoke<void>("close_trace", { stage }),
  confirmWindowClose: () => invoke<void>("confirm_window_close"),

  /** Quit the whole app (all per-window machines already resolved). */
  quit: () => invoke<void>("quit_app"),

  /** Open an external link in the system browser (explicit click only). */
  openExternal: (url: string) => invoke<void>("open_external_url", { url }),

  documents: {
    new: () => invoke<string>("documents_new"),
    open: (path: string, convertLatin1 = false) =>
      invoke<DocumentSnapshot>("documents_open", { path, convertLatin1 }),
    snapshot: (docId: string) =>
      invoke<DocumentSnapshot | null>("documents_snapshot", { docId }),
    acquire: (docId: string) => invoke<number>("documents_acquire", { docId }),
    release: (docId: string) => invoke<number>("documents_release", { docId }),
    dispose: (docId: string) => invoke<boolean>("documents_dispose", { docId }),
    apply: (docId: string, baseRevision: number, ops: DocOp[]) =>
      invoke<DocumentUpdate>("documents_apply", {
        docId,
        baseRevision,
        ops,
      }),
    undo: (docId: string) =>
      invoke<DocumentUpdate | null>("documents_undo", { docId }),
    redo: (docId: string) =>
      invoke<DocumentUpdate | null>("documents_redo", { docId }),
    save: (docId: string) => invoke<SaveResult>("documents_save", { docId }),
    reload: (docId: string, baseRevision: number) =>
      invoke<DocumentSnapshot>("documents_reload", { docId, baseRevision }),
    saveAs: (docId: string, path: string) =>
      invoke<SaveResult>("documents_save_as", { docId, path }),
    applyLocalized: (docId: string, baseRevision: number, ops: DocOp[]) =>
      invoke<DocumentUpdate>("documents_apply_localized", { docId, baseRevision, ops }),
    recoverySnapshot: (docId: string, draft: string | null) =>
      invoke<RecoveryInfo | null>("documents_recovery_snapshot", {
        docId,
        draft,
      }),
  },

  drafts: {
    acquire: (docId: string, opening: DraftOpening) => invoke<DraftLease>("drafts_acquire", { docId, opening }),
    info: (docId: string) => invoke<DraftLease | null>("drafts_info", { docId }),
    update: (docId: string, token: string, update: { generation: number; text: string; valid: boolean }) =>
      invoke<DraftLease>("drafts_update", { docId, token, update }),
    release: (docId: string, token: string) => invoke<void>("drafts_release", { docId, token }),
    resume: (docId: string, token: string) => invoke<DraftLease>("drafts_resume", { docId, token }),
    apply: (docId: string, token: string, generation: number, ops: DocOp[]) =>
      invoke<DocumentUpdate | null>("drafts_apply", { docId, token, generation, ops }),
  },

  recovery: {
    list: () => invoke<RecoveryInfo[]>("recovery_list"),
    discard: (key: string) => invoke<void>("recovery_discard", { key }),
    restore: (key: string) => invoke<RecoveryPayload>("recovery_restore", { key, visual: true }),
  },

  settings: {
    get: () => invoke<Settings>("settings_get"),
    set: (settings: Settings) => invoke<void>("settings_set", { settings }),
  },

  session: {
    get: () => invoke<SessionState>("session_get"),
    set: (state: SessionState) => invoke<void>("session_set", { state }),
  },

  files: {
    /** Which of these paths exist as files (FR-004 recents pruning). */
    exist: (paths: string[]) => invoke<boolean[]>("files_exist", { paths }),
  },

  dialogs: {
    openMarkdown: () => invoke<string | null>("dialog_open_markdown"),
    openFolder: () => invoke<string | null>("dialog_open_folder"),
    saveMarkdown: (suggestedName?: string) =>
      invoke<string | null>("dialog_save_markdown", { suggestedName }),
  },
};

// --- events ---------------------------------------------------------------

export const EV_DOC_UPDATED = "document-updated";
export type LifecycleTrigger = "quit" | "close-window" | "close-tab" | "mode-switch" | "tab-switch" | "reload-document";
export interface LifecycleRequest {
  id: number;
  transaction: number;
  action: "prepare" | "resolve-draft" | "discard-draft" | "resolve-canonical";
  body: { displayName?: string; summary?: string[]; trigger?: LifecycleTrigger; lease?: DraftLease; snapshot?: DocumentSnapshot; token?: string; docId?: string };
}
export const onLifecycleRequest = (callback: (request: LifecycleRequest) => void) =>
  listen<LifecycleRequest>("lifecycle-request", (event) => callback(event.payload), { target: { kind: "Window", label: getCurrentWindow().label } });
export const onLifecycleRelease = (callback: (transaction: number) => void) =>
  listen<{ transaction: number }>("lifecycle-release", (event) => callback(event.payload.transaction), { target: { kind: "Window", label: getCurrentWindow().label } });
export const onLifecycleError = (callback: (error: string) => void) =>
  listen<string>("lifecycle-error", (event) => callback(event.payload), { target: { kind: "Window", label: getCurrentWindow().label } });
export const EV_DOC_CHANGED_ON_DISK = "document-changed-on-disk";
export const EV_DOC_SAVED = "document-saved";
export const EV_MENU_COMMAND = "menu-command";
export const EV_WINDOW_CLOSE_REQUESTED = "tauri://close-requested";

export interface DiskChangedEvent {
  docId: string;
  autoReload: boolean;
}

export async function onDocumentUpdated(
  cb: (u: DocumentUpdate) => void,
): Promise<UnlistenFn> {
  return listen<DocumentUpdate>(EV_DOC_UPDATED, (e) => cb(e.payload));
}

export async function onDocumentSaved(cb: (event: { docId: string }) => void): Promise<UnlistenFn> {
  return listen<{ docId: string }>(EV_DOC_SAVED, (event) => cb(event.payload));
}

export async function onDocumentChangedOnDisk(
  cb: (e: DiskChangedEvent) => void,
): Promise<UnlistenFn> {
  return listen<DiskChangedEvent>(EV_DOC_CHANGED_ON_DISK, (e) => cb(e.payload));
}

export async function onMenuCommand(
  cb: (id: string) => void,
): Promise<UnlistenFn> {
  return listen<{ id: string }>(EV_MENU_COMMAND, (e) => cb(e.payload.id), {
    target: { kind: "Window", label: getCurrentWindow().label },
  });
}

export async function onWindowCloseRequested(
  cb: () => void,
): Promise<UnlistenFn> {
  return getCurrentWindow().onCloseRequested((event) => {
    event.preventDefault();
    void native.closeTrace("requested").catch(() => {});
    cb();
  });
}

export interface DragDropEventPayload {
  type: "enter" | "over" | "drop" | "leave";
  /** Filesystem paths for enter/drop; position for enter/over/drop. */
  paths?: string[];
  position?: { x: number; y: number };
}

/**
 * Native OS drag & drop (FR-001). Tauri core intercepts the webview's
 * drag handlers and emits `tauri://drag-drop` with real filesystem paths —
 * no plugin, and the payload carries paths (the HTML5 `File` API would not).
 */
export async function onDragDrop(
  cb: (e: DragDropEventPayload) => void,
): Promise<UnlistenFn> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().onDragDropEvent((e) => cb(e.payload));
}

export async function openNewWindow(): Promise<WebviewWindow> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return new WebviewWindow(`window-${crypto.randomUUID()}`, {
    title: "Marquellium",
    width: 1100,
    height: 750,
  });
}

export function onDraftChanged(cb: (event: { docId: string; lease: DraftLease | null }) => void): Promise<UnlistenFn> {
  return listen<{ docId: string; lease: DraftLease | null }>("draft-changed", (event) => cb(event.payload));
}

/** Explicit development entry; normal Visual mode stays gated until M3V passes. */
export async function openVisualPrototype(docId: string): Promise<WebviewWindow> {
  if (import.meta.env.VITE_M3V_VISUAL_PROTOTYPE !== "1") throw new Error("Visual prototype is not enabled in this build");
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return new WebviewWindow(`visual-${crypto.randomUUID()}`, {
    title: "Marquellium — M3V prototype", width: 1000, height: 750,
    url: `index.html?m3vDocument=${encodeURIComponent(docId)}`,
  });
}

export const onSettingsChanged = (callback: (settings: Settings) => void) => listen<Settings>("settings-changed", (event) => callback(event.payload));
