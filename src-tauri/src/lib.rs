//! Markdown Viewer — Rust core.
//!
//! Module layout (PRD §8.2):
//! - `documents`  — DocumentService + DocumentRegistry: canonical buffers,
//!   revision-checked transactions/undo, atomic saves, recovery snapshots.
//! - `workspace`  — scoped paths, directory listing (watcher lives here in
//!   `watch.rs` via the app state).
//! - `assets`     — clipboard/import (M4).
//! - `export`     — HTML/PDF/DOCX (M5).
//! - `settings`   — schema-versioned app-data persistence.
//!
//! Security posture (ADR-005): the frontend never receives unrestricted
//! filesystem access. Every file operation is a scoped, audited command.

pub mod assets;
pub mod documents;
pub mod export;
pub mod media;
pub mod session;
pub mod settings;
pub mod workspace;

use crate::media::MediaScope;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use notify::Watcher as _;
use tauri::{Emitter, Manager, State};

use crate::documents::{
    wire_ops, DiskRevision, DocId, DocumentRegistry, DocumentUpdate, RecoveryInfo,
    RecoveryStore, TransactionRecord,
};
use crate::documents::service::{disk_revision, open_document, save_atomic, save_as_atomic, DocumentSnapshot, SaveResult};
use crate::documents::{DocOp, WireTransaction};
use crate::session::{SessionState, SessionStore};
use crate::settings::{Settings, SettingsStore};

/// Events (names are the frontend contract).
pub const EV_DOC_UPDATED: &str = "document-updated";
pub const EV_DOC_CHANGED_ON_DISK: &str = "document-changed-on-disk";
pub const EV_DOC_SAVED: &str = "document-saved";
pub const EV_MENU_COMMAND: &str = "menu-command";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MenuCmd {
    id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DiskChangedEvent {
    doc_id: DocId,
    /// True when the registry reports the doc clean and no draft is active:
    /// the frontend may auto-reload (ADR-008/AT-108).
    auto_reload: bool,
}

/// File watcher state: a notify watcher feeding a channel drained by a
/// debounced task in `setup`.
pub struct WatchState {
    pub tx: tokio::sync::mpsc::UnboundedSender<PathBuf>,
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.markdownviewer.desktop")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub data_dir: String,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: "Markdown Viewer".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: app_data_dir().to_string_lossy().into_owned(),
    }
}

// ---------------------------------------------------------------------------
// Document commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn documents_new(reg: State<'_, DocumentRegistry>) -> DocId {
    reg.create_untitled()
}

#[tauri::command]
fn documents_open(
    reg: State<'_, DocumentRegistry>,
    watch: State<'_, WatchState>,
    scope: State<'_, MediaScope>,
    path: String,
    convert_latin1: bool,
) -> Result<DocumentSnapshot, String> {
    // Canonicalize so alias paths (symlinks, ..) map to one registry entry;
    // the watcher, saves, and multi-window lookups all key off this string.
    let path_buf = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    watch_follow(&watch, &path_buf);
    media_follow(&scope, &path_buf);
    // Multi-window (FR-043/AT-117): if another window already opened this
    // file, reuse the canonical entry — the caller's acquire() bumps views.
    if let Some(id) = reg.find_by_path(&path_buf) {
        return reg
            .snapshot(&id)
            .ok_or_else(|| format!("failed to read back {id}"));
    }
    let (content, bom, newline, rev) =
        open_document(&path_buf, convert_latin1).map_err(|e| e.to_string())?;
    let id = reg
        .insert_opened(&path_buf, content, bom, newline, rev)
        .map_err(|e| e.to_string())?;
    reg.snapshot(&id).ok_or_else(|| format!("failed to read back {id}"))
}

/// Allow media serving from the directory containing `path` (FR-023:
/// document-relative images resolve against the containing document).
fn media_follow(scope: &State<'_, MediaScope>, path: &std::path::Path) {
    if let Some(parent) = path.parent() {
        scope.add_root(parent);
    }
}

fn watch_follow(watch: &State<'_, WatchState>, path: &std::path::Path) {
    let Ok(mut guard) = watch.watcher.lock() else {
        return;
    };
    if let Some(w) = guard.as_mut() {
        let _ = w.watch(path, notify::RecursiveMode::NonRecursive);
    }
}

#[tauri::command]
fn documents_snapshot(reg: State<'_, DocumentRegistry>, doc_id: String) -> Option<DocumentSnapshot> {
    reg.snapshot(&doc_id)
}

#[tauri::command]
fn documents_acquire(reg: State<'_, DocumentRegistry>, doc_id: String) -> Result<u32, String> {
    reg.acquire_view(&doc_id)
}

#[tauri::command]
fn documents_release(reg: State<'_, DocumentRegistry>, doc_id: String) -> Result<u32, String> {
    reg.release_view(&doc_id)
}

#[tauri::command]
fn documents_dispose(
    reg: State<'_, DocumentRegistry>,
    doc_id: String,
    recovery: State<'_, RecoveryStore>,
) -> bool {
    let path = reg.snapshot(&doc_id).and_then(|s| s.path);
    if !reg.dispose(&doc_id) {
        return false;
    }
    let key = RecoveryStore::key_for(&path.map(PathBuf::from), &doc_id);
    recovery.remove(&key);
    true
}

fn build_update(reg: &DocumentRegistry, id: &str, kind: &str, record: &TransactionRecord) -> DocumentUpdate {
    DocumentUpdate {
        doc_id: id.to_string(),
        revision: record.revision,
        ops: wire_ops(record),
        dirty: reg.is_dirty(id).unwrap_or(false),
        kind: kind.to_string(),
    }
}

#[tauri::command]
fn documents_apply(
    app: tauri::AppHandle,
    reg: State<'_, DocumentRegistry>,
    doc_id: String,
    base_revision: u64,
    ops: Vec<DocOp>,
) -> Result<DocumentUpdate, String> {
    let record = reg
        .apply_transaction(
            &doc_id,
            &WireTransaction {
                base_revision,
                ops,
            },
        )
        .map_err(|e| e.to_string())?;
    let update = build_update(&reg, &doc_id, "edit", &record);
    let _ = app.emit(EV_DOC_UPDATED, &update);
    Ok(update)
}

#[tauri::command]
fn documents_undo(
    app: tauri::AppHandle,
    reg: State<'_, DocumentRegistry>,
    doc_id: String,
) -> Result<Option<DocumentUpdate>, String> {
    let record = reg.undo(&doc_id)?;
    Ok(record.map(|r| {
        let u = build_update(&reg, &doc_id, "undo", &r);
        let _ = app.emit(EV_DOC_UPDATED, &u);
        u
    }))
}

#[tauri::command]
fn documents_redo(
    app: tauri::AppHandle,
    reg: State<'_, DocumentRegistry>,
    doc_id: String,
) -> Result<Option<DocumentUpdate>, String> {
    let record = reg.redo(&doc_id)?;
    Ok(record.map(|r| {
        let u = build_update(&reg, &doc_id, "redo", &r);
        let _ = app.emit(EV_DOC_UPDATED, &u);
        u
    }))
}

fn mark_saved(reg: &DocumentRegistry, id: &str, rev: &DiskRevision) {
    let _ = reg.mark_saved(id, rev.clone());
}

#[tauri::command]
fn documents_save(
    app: tauri::AppHandle,
    reg: State<'_, DocumentRegistry>,
    recovery: State<'_, RecoveryStore>,
    scope: State<'_, MediaScope>,
    doc_id: String,
) -> Result<SaveResult, String> {
    let (path, expected) = {
        let snap = reg
            .snapshot(&doc_id)
            .ok_or_else(|| format!("unknown document {doc_id}"))?;
        let path = match snap.path {
            Some(p) => PathBuf::from(p),
            None => {
                return Ok(SaveResult {
                    ok: false,
                    revision: None,
                    reason: Some("untitled".into()),
                    message: Some("use save-as for a new document".into()),
                });
            }
        };
        (path, snap.saved_disk_revision)
    };
    let bytes = reg.canonical_bytes(&doc_id).unwrap_or_default();
    match save_atomic(&path, &bytes, expected.as_ref()) {
        Ok(rev) => {
            mark_saved(&reg, &doc_id, &rev);
            media_follow(&scope, &path);
            let key = RecoveryStore::key_for(&Some(path.clone()), &doc_id);
            recovery.remove(&key);
            let _ = app.emit(
                EV_DOC_SAVED,
                serde_json::json!({ "docId": doc_id, "revision": rev }),
            );
            Ok(SaveResult {
                ok: true,
                revision: Some(rev),
                reason: None,
                message: None,
            })
        }
        Err(e) => Ok(SaveResult {
            ok: false,
            revision: None,
            reason: Some(if e.is_conflict() {
                "conflict".into()
            } else {
                "io-error".into()
            }),
            message: Some(e.to_string()),
        }),
    }
}

#[tauri::command]
fn documents_save_as(
    app: tauri::AppHandle,
    reg: State<'_, DocumentRegistry>,
    recovery: State<'_, RecoveryStore>,
    scope: State<'_, MediaScope>,
    doc_id: String,
    path: String,
) -> Result<SaveResult, String> {
    let path_buf = PathBuf::from(&path);
    // Absence permits explicit creation; existing targets remain revision-checked.
    let bytes = reg.canonical_bytes(&doc_id).unwrap_or_default();
    let expected = disk_revision(&path_buf).ok();
    match save_as_atomic(&path_buf, &bytes, expected.as_ref()) {
        Ok(rev) => {
            media_follow(&scope, &path_buf);
            let _ = reg.rename_document(&doc_id, path.clone());
            let _ = reg.mark_saved(&doc_id, rev.clone());
            let key = RecoveryStore::key_for(&Some(path_buf.clone()), &doc_id);
            recovery.remove(&key);
            let _ = app.emit(
                EV_DOC_SAVED,
                serde_json::json!({ "docId": doc_id, "path": path, "revision": rev }),
            );
            Ok(SaveResult {
                ok: true,
                revision: Some(rev),
                reason: None,
                message: None,
            })
        }
        Err(e) => Ok(SaveResult {
            ok: false,
            revision: None,
            reason: Some(if e.is_conflict() {
                "conflict".into()
            } else {
                "io-error".into()
            }),
            message: Some(e.to_string()),
        }),
    }
}

/// Confirmed reload (FR-005/AT-108): replace the canonical buffer with the
/// current disk content as one transaction (undoable), then mark saved.
/// Only called after the user explicitly chose to reload.
#[tauri::command]
fn documents_reload(
    app: tauri::AppHandle,
    reg: State<'_, DocumentRegistry>,
    doc_id: String,
) -> Result<DocumentSnapshot, String> {
    let (path, revision) = {
        let snap = reg
            .snapshot(&doc_id)
            .ok_or_else(|| format!("unknown document {doc_id}"))?;
        let path = snap
            .path
            .clone()
            .ok_or_else(|| "untitled documents cannot be reloaded".to_string())?;
        (PathBuf::from(path), snap.revision)
    };
    let (content, bom, newline, rev) =
        open_document(&path, false).map_err(|e| e.to_string())?;
    let current_bytes = reg.canonical_bytes(&doc_id).unwrap_or_default();
    let record = reg
        .apply_transaction(
            &doc_id,
            &WireTransaction {
                base_revision: revision,
                ops: vec![DocOp {
                    start_byte: 0,
                    end_byte: current_bytes.len() as u32,
                    text: content,
                }],
            },
        )
        .map_err(|e| e.to_string())?;
    let _ = reg.set_meta(&doc_id, bom, newline);
    let _ = reg.mark_saved(&doc_id, rev);
    let update = build_update(&reg, &doc_id, "edit", &record);
    let _ = app.emit(EV_DOC_UPDATED, &update);
    reg.snapshot(&doc_id)
        .ok_or_else(|| format!("failed to read back {doc_id}"))
}

#[tauri::command]
fn documents_set_draft(
    reg: State<'_, DocumentRegistry>,
    doc_id: String,
    token: Option<String>,
) -> Result<(), String> {
    reg.set_draft_active(&doc_id, token)
}

/// Debounced recovery snapshot (FR-006). Content is the canonical buffer as
/// it stands; `draft` carries a modified inline draft (ADR-008) if active.
#[tauri::command]
fn documents_recovery_snapshot(
    reg: State<'_, DocumentRegistry>,
    recovery: State<'_, RecoveryStore>,
    doc_id: String,
    draft: Option<String>,
) -> Result<Option<RecoveryInfo>, String> {
    let snap = reg.snapshot(&doc_id).ok_or_else(|| format!("unknown document {doc_id}"))?;
    if !snap.dirty {
        return Ok(None); // nothing to recover
    }
    let path_opt: Option<PathBuf> = snap.path.as_ref().map(PathBuf::from);
    let key = RecoveryStore::key_for(&path_opt, &doc_id);
    let bytes = reg.canonical_bytes(&doc_id).unwrap_or_default();
    let path_ref: Option<&std::path::Path> = path_opt.as_deref();
    recovery
        .snapshot(&key, path_ref, &bytes, snap.revision, draft)
        .map(Some)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Recovery commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn recovery_list(recovery: State<'_, RecoveryStore>) -> Vec<RecoveryInfo> {
    recovery.list()
}

#[tauri::command]
fn recovery_discard(recovery: State<'_, RecoveryStore>, key: String) {
    recovery.remove(&key);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryPayload {
    key: String,
    path: Option<String>,
    bytes: Vec<u8>,
    revision: u64,
    draft: Option<String>,
}

#[tauri::command]
fn recovery_restore(recovery: State<'_, RecoveryStore>, key: String) -> Result<RecoveryPayload, String> {
    let (bytes, meta) = recovery.read(&key).map_err(|e| e.to_string())?;
    Ok(RecoveryPayload {
        key,
        path: meta.path,
        bytes,
        revision: meta.revision,
        draft: meta.draft,
    })
}

// ---------------------------------------------------------------------------
// Settings commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn settings_get(store: State<'_, SettingsStore>) -> Settings {
    // Normalizing on read self-heals a previously persisted zeroed payload
    // (e.g. sidebar width 0) without touching the file until the next save.
    store.load().normalized()
}

#[tauri::command]
fn settings_set(store: State<'_, SettingsStore>, settings: Settings) -> Result<(), String> {
    store.save(&settings.normalized()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Session commands (FR-033 / FR-004)
// ---------------------------------------------------------------------------

#[tauri::command]
fn session_get(store: State<'_, SessionStore>) -> SessionState {
    store.load()
}

#[tauri::command]
fn session_set(store: State<'_, SessionStore>, state: SessionState) -> Result<(), String> {
    store.save(&state.normalized()).map_err(|e| e.to_string())
}

/// Existence check for the recent-files list (FR-004: recent entries omit
/// unavailable files gracefully). Read-only stat; the UI never touches the
/// filesystem itself (ADR-005).
#[tauri::command]
fn files_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| std::path::Path::new(p).is_file()).collect()
}

// ---------------------------------------------------------------------------
// Workspace commands (scoped, ADR-005)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Native dialogs (via rfd — no webview dialog plugin, ADR-005)
// ---------------------------------------------------------------------------

/// Open a native file picker filtered to Markdown. Runs off the main thread.
#[tauri::command]
async fn dialog_open_markdown() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Open Markdown")
            .add_filter("Markdown", &["md", "markdown"])
            .add_filter("All files", &["*"])
            .pick_file()
    })
    .await
    .ok()
    .flatten()
    .map(|p| p.to_string_lossy().into_owned())
}

/// Open a native "choose folder" dialog (workspace mode, FR-007).
#[tauri::command]
async fn dialog_open_folder() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new().set_title("Open Folder").pick_folder()
    })
    .await
    .ok()
    .flatten()
    .map(|p| p.to_string_lossy().into_owned())
}

/// Native save dialog for Save / Save As.
#[tauri::command]
async fn dialog_save_markdown(suggested_name: Option<String>) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = rfd::FileDialog::new().set_title("Save Markdown");
        if let Some(name) = suggested_name {
            d = d.set_file_name(name);
        }
        d.save_file()
    })
    .await
    .ok()
    .flatten()
    .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn workspace_list_dir(root: String) -> Result<Vec<workspace::DirEntry>, String> {
    workspace::list_dir(&PathBuf::from(&root)).map_err(|e| e.to_string())
}

#[tauri::command]
fn path_in_scope(scope: String, path: String) -> Result<String, String> {
    workspace::resolve_in_scope(&PathBuf::from(&scope), &PathBuf::from(&path))
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let new = MenuItem::with_id(app, "new", "New", true, Some("CmdOrCtrl+N"))?;
    let open = MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?;
    let save = MenuItem::with_id(app, "save", "Save", true, Some("CmdOrCtrl+S"))?;
    let save_as = MenuItem::with_id(app, "save_as", "Save As…", true, Some("Shift+CmdOrCtrl+S"))?;
    let close_tab = MenuItem::with_id(app, "close_tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;

    let file = Submenu::with_items(app, "File", true, &[
        &new as &dyn IsMenuItem<tauri::Wry>,
        &open,
        &save,
        &save_as,
        &PredefinedMenuItem::separator(app)?,
        &close_tab,
        &PredefinedMenuItem::separator(app)?,
        &quit,
    ])?;

    let edit = Submenu::with_items(app, "Edit", true, &[
        &PredefinedMenuItem::undo(app, None)? as &dyn IsMenuItem<tauri::Wry>,
        &PredefinedMenuItem::redo(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::cut(app, None)?,
        &PredefinedMenuItem::copy(app, None)?,
        &PredefinedMenuItem::paste(app, None)?,
        &PredefinedMenuItem::select_all(app, None)?,
    ])?;

    let read = MenuItem::with_id(app, "mode:read", "Read", true, Some("CmdOrCtrl+1"))?;
    let source = MenuItem::with_id(app, "mode:source", "Source", true, Some("CmdOrCtrl+2"))?;
    let split = MenuItem::with_id(app, "mode:split", "Split", true, Some("CmdOrCtrl+3"))?;
    let visual = MenuItem::with_id(app, "mode:visual", "Visual", true, Some("CmdOrCtrl+4"))?;
    let view = Submenu::with_items(app, "View", true, &[
        &read as &dyn IsMenuItem<tauri::Wry>,
        &source,
        &split,
        &visual,
    ])?;

    let new_window = MenuItem::with_id(app, "new_window", "New Window", true, None::<&str>)?;
    let window = Submenu::with_items(app, "Window", true, &[&new_window as &dyn IsMenuItem<tauri::Wry>])?;

    let menu = Menu::with_items(app, &[
        &file as &dyn IsMenuItem<tauri::Wry>,
        &edit,
        &view,
        &window,
    ])?;
    app.set_menu(menu)?;
    Ok(())
}

/// Debounced disk-change handler for open documents.
async fn drain_watcher(app: tauri::AppHandle, mut rx: tokio::sync::mpsc::UnboundedReceiver<PathBuf>) {
    let mut pending: HashSet<PathBuf> = HashSet::new();
    loop {
        tokio::select! {
            next = rx.recv() => match next {
                Some(p) => {
                    pending.insert(p);
                }
                None => break,
            },
            _ = tokio::time::sleep(Duration::from_millis(300)) => {}
        }
        if pending.is_empty() {
            continue;
        }
        let paths: Vec<PathBuf> = pending.drain().collect();
        if let Some(reg) = app.try_state::<DocumentRegistry>() {
            for p in &paths {
                let Some(rev) = disk_revision(p).ok() else {
                    continue; // deleted/renamed away: next save will surface it
                };
                for id in reg.get() {
                    let Some(snap) = reg.snapshot(&id) else { continue };
                    let Some(path) = snap.path.as_deref() else { continue };
                    if path != p.to_str().unwrap_or("") {
                        continue;
                    }
                    let auto_reload = !snap.dirty && snap.draft_active.is_none();
                    if reg.disk_changed(&id, rev.clone()) {
                        let _ = app.emit(
                            EV_DOC_CHANGED_ON_DISK,
                            DiskChangedEvent {
                                doc_id: id.clone(),
                                auto_reload,
                            },
                        );
                    }
                }
            }
        }
    }
}

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "kebab-case")]
enum CloseStage { Requested, CoordinatorStart, Resolved, Cancelled }

/// Contains lifecycle stages only: never document text or filesystem paths.
#[tauri::command]
fn close_trace(window: tauri::Window, stage: CloseStage) {
    eprintln!("close-flow window={} stage={stage:?}", window.label());
}

/// Only invoked after the frontend coordinator resolves unsaved work.
/// Destroy bypasses a second close request and its prevention handshake.
#[tauri::command]
fn confirm_window_close(window: tauri::Window) -> Result<(), String> {
    eprintln!("close-flow window={} stage=DestroyRequested", window.label());
    window.destroy().map_err(|e| e.to_string())
}

/// Open an external link in the system browser (explicit user click only —
/// the webview never navigates to or fetches remote content, T4). The
/// scheme allowlist mirrors the frontend URL policy: http/https/mailto.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let clean: String = url
        .chars()
        .filter(|c| !c.is_control() && *c != ' ' && *c != '\t')
        .collect();
    let lower = clean.to_ascii_lowercase();
    if !(lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:"))
    {
        return Err("only http, https, and mailto links can be opened".into());
    }
    open::that(&clean).map_err(|e| e.to_string())
}

/// Request guarded closure of every window; unresolved edits can cancel closure.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    eprintln!("close-flow stage=QuitRequested");
    // Each window must resolve its own buffered edits and dirty documents.
    for window in app.webview_windows().values() {
        if let Err(err) = window.close() {
            eprintln!("close-flow window={} close-error={err}", window.label());
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data_dir = app_data_dir();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<PathBuf>();
    let tx_for_state = tx.clone();
    let media = MediaScope::default();

    let builder = tauri::Builder::default()
        .manage(DocumentRegistry::new())
        .manage(RecoveryStore::new(data_dir.join("recovery")))
        .manage(SettingsStore::new(data_dir.join("settings.json")))
        .manage(SessionStore::new(data_dir.join("session.json")))
        .manage(WatchState {
            tx: tx_for_state,
            watcher: Mutex::new(None),
        })
        .manage(media.clone())
        .plugin(tauri_plugin_clipboard_manager::init());

    let builder = builder
        // Document images load through the scoped local-media: protocol
        // (ADR-003, T3): every request is canonicalized and checked against
        // the parent directories of open documents.
        .register_asynchronous_uri_scheme_protocol(
            "local-media",
            move |_ctx, request, responder| {
                let scope = media.clone();
                let uri = request.uri().to_string();
                std::thread::spawn(move || {
                    use tauri::http::{Response, StatusCode};
                    let (status, mime, body) = match crate::media::media_path_from_uri(&uri) {
                        Some(p) => match scope.resolve(&p) {
                            Ok(file) => (StatusCode::OK, Some(file.mime), file.bytes),
                            Err(_) => (StatusCode::NOT_FOUND, None, Vec::new()),
                        },
                        None => (StatusCode::NOT_FOUND, None, Vec::new()),
                    };
                    let mut builder = Response::builder().status(status);
                    if let Some(m) = mime {
                        builder = builder.header("content-type", m);
                    }
                    builder = builder.header("cache-control", "no-store");
                    responder.respond(builder.body(body).expect("response builds"));
                });
            },
        )
        .setup(move |app| {
            let handle = app.handle().clone();
            if let Ok(w) = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(ev) = res {
                    for p in ev.paths {
                        let _ = tx.send(p);
                    }
                }
            }) {
                *app.state::<WatchState>().watcher.lock().expect("watch lock") = Some(w);
            }
            tauri::async_runtime::spawn(drain_watcher(handle, rx));

            build_menu(app.handle())?;
            app.on_menu_event(|app, event| {
                // Quit is application-wide, including while no window has focus.
                if event.id.0 == "quit" {
                    quit_app(app.clone());
                    return;
                }
                for window in app.webview_windows().values() {
                    if window.is_focused().unwrap_or(false) {
                        let _ = window.emit_to(tauri::EventTarget::window(window.label()), EV_MENU_COMMAND, MenuCmd { id: event.id.0.clone() });
                        break;
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                eprintln!("close-flow window={} stage=Destroyed", window.label());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Tauri emits tauri://close-requested to this window. Stay
                // open until its frontend resolves Save/Discard/Cancel.
                eprintln!("close-flow window={} stage=NativeCloseRequested", window.label());
                api.prevent_close();
            }
        });

    builder
        .invoke_handler(tauri::generate_handler![
            app_info,
            documents_new,
            documents_open,
            documents_snapshot,
            documents_acquire,
            documents_release,
            documents_dispose,
            documents_apply,
            documents_undo,
            documents_redo,
            documents_save,
            documents_save_as,
            documents_reload,
            dialog_open_markdown,
            dialog_open_folder,
            dialog_save_markdown,
            documents_set_draft,
            documents_recovery_snapshot,
            recovery_list,
            recovery_discard,
            recovery_restore,
            settings_get,
            settings_set,
            session_get,
            session_set,
            files_exist,
            workspace_list_dir,
            path_in_scope,
            close_trace,
            confirm_window_close,
            quit_app,
            open_external_url
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // OS/Dock Quit must resolve the same unsaved-work flow as menu Quit.
            // Allow the normal exit when the last resolved window is gone.
            if let tauri::RunEvent::ExitRequested { api, code: None, .. } = event {
                if !app.webview_windows().is_empty() {
                    api.prevent_exit();
                    quit_app(app.clone());
                }
            }
        });
}

