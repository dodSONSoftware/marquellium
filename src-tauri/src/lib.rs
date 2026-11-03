//! Marquellium — Rust core.
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
mod file_open;
mod lifecycle;
#[cfg(target_os = "macos")]
mod macos_termination;
pub mod media;
mod preview;
pub mod session;
pub mod settings;
pub mod workspace;

use crate::media::MediaScope;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify::Watcher as _;
use serde::Serialize;
use tauri::{Emitter, Manager, State};

use crate::documents::service::{open_document, DocumentSnapshot, SaveResult};
use crate::documents::{
    wire_ops, DocId, DocumentRegistry, DocumentUpdate, DraftLease, DraftOpening, DraftUpdate,
    RecoveryInfo, RecoveryStore, TransactionRecord,
};
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
    if let Some(path) = std::env::var_os("MARKDOWN_VIEWER_DATA_DIR") {
        return PathBuf::from(path);
    }
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
        name: "Marquellium".to_string(),
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
    reg.snapshot(&id)
        .ok_or_else(|| format!("failed to read back {id}"))
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
fn documents_snapshot(
    reg: State<'_, DocumentRegistry>,
    doc_id: String,
) -> Option<DocumentSnapshot> {
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
    let key = recovery.document_key(&path.map(PathBuf::from), &doc_id);
    recovery.remove(&key);
    true
}

fn build_update(
    reg: &DocumentRegistry,
    id: &str,
    kind: &str,
    record: &TransactionRecord,
) -> DocumentUpdate {
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
        .apply_transaction(&doc_id, &WireTransaction { base_revision, ops })
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

fn maintain_recovery(
    window: &tauri::Window,
    reg: &DocumentRegistry,
    recovery: &RecoveryStore,
    doc_id: &str,
) {
    if let Err(error) = recovery.persist_document(reg, doc_id) {
        let message = format!("The action completed, but recovery could not be updated: {error}. Keep the app open and save a copy if needed.");
        let _ = window.emit_to(
            tauri::EventTarget::window(window.label()),
            "lifecycle-error",
            message,
        );
    }
}

#[tauri::command]
fn documents_save(
    app: tauri::AppHandle,
    window: tauri::Window,
    reg: State<'_, DocumentRegistry>,
    recovery: State<'_, RecoveryStore>,
    scope: State<'_, MediaScope>,
    doc_id: String,
) -> Result<SaveResult, String> {
    let path = {
        let snap = reg
            .snapshot(&doc_id)
            .ok_or_else(|| format!("unknown document {doc_id}"))?;
        match snap.path {
            Some(p) => PathBuf::from(p),
            None => {
                return Ok(SaveResult {
                    ok: false,
                    revision: None,
                    reason: Some("untitled".into()),
                    message: Some("use save-as for a new document".into()),
                });
            }
        }
    };
    match reg.save_to_disk(&doc_id, None) {
        Ok(rev) => {
            media_follow(&scope, &path);
            maintain_recovery(&window, &reg, &recovery, &doc_id);
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
    window: tauri::Window,
    reg: State<'_, DocumentRegistry>,
    recovery: State<'_, RecoveryStore>,
    scope: State<'_, MediaScope>,
    doc_id: String,
    path: String,
) -> Result<SaveResult, String> {
    let path_buf = PathBuf::from(&path);
    if reg.snapshot(&doc_id).is_none() {
        return Err(format!("unknown document {doc_id}"));
    }
    match reg.save_to_disk(&doc_id, Some(path_buf.clone())) {
        Ok(rev) => {
            media_follow(&scope, &path_buf);
            maintain_recovery(&window, &reg, &recovery, &doc_id);
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
    recovery: State<'_, RecoveryStore>,
    doc_id: String,
    base_revision: u64,
) -> Result<DocumentSnapshot, String> {
    let record = reg.reload_from_disk(&doc_id, base_revision, false)?;
    recovery
        .persist_document(&reg, &doc_id)
        .map_err(|e| e.to_string())?;
    let update = build_update(&reg, &doc_id, "edit", &record);
    let _ = app.emit(EV_DOC_UPDATED, &update);
    reg.snapshot(&doc_id)
        .ok_or_else(|| format!("failed to read back {doc_id}"))
}

fn emit_draft_state(app: &tauri::AppHandle, reg: &DocumentRegistry, doc_id: &str) {
    let _ = app.emit(
        "draft-changed",
        serde_json::json!({ "docId": doc_id, "lease": reg.draft_info(doc_id) }),
    );
}

#[tauri::command]
fn drafts_acquire(
    app: tauri::AppHandle,
    window: tauri::Window,
    reg: State<'_, DocumentRegistry>,
    doc_id: String,
    opening: DraftOpening,
) -> Result<DraftLease, String> {
    let lease = reg.acquire_draft(&doc_id, window.label(), opening)?;
    emit_draft_state(&app, &reg, &doc_id);
    Ok(lease)
}

#[tauri::command]
fn drafts_update(
    app: tauri::AppHandle,
    window: tauri::Window,
    reg: State<'_, DocumentRegistry>,
    recovery: State<'_, RecoveryStore>,
    doc_id: String,
    token: String,
    update: DraftUpdate,
) -> Result<DraftLease, String> {
    let lease = reg.update_draft(&doc_id, window.label(), &token, update)?;
    recovery
        .persist_document(&reg, &doc_id)
        .map_err(|e| e.to_string())?;
    emit_draft_state(&app, &reg, &doc_id);
    Ok(lease)
}

#[tauri::command]
fn drafts_release(
    app: tauri::AppHandle,
    window: tauri::Window,
    reg: State<'_, DocumentRegistry>,
    recovery: State<'_, RecoveryStore>,
    doc_id: String,
    token: String,
) -> Result<(), String> {
    reg.release_draft(&doc_id, window.label(), &token)?;
    maintain_recovery(&window, &reg, &recovery, &doc_id);
    emit_draft_state(&app, &reg, &doc_id);
    Ok(())
}

#[tauri::command]
fn drafts_info(reg: State<'_, DocumentRegistry>, doc_id: String) -> Option<DraftLease> {
    reg.draft_info(&doc_id)
}

#[tauri::command]
fn drafts_resume(
    app: tauri::AppHandle,
    window: tauri::Window,
    reg: State<'_, DocumentRegistry>,
    doc_id: String,
    token: String,
) -> Result<DraftLease, String> {
    let lease = reg.resume_draft(&doc_id, window.label(), &token)?;
    emit_draft_state(&app, &reg, &doc_id);
    Ok(lease)
}

#[tauri::command]
fn drafts_apply(
    window: tauri::Window,
    reg: State<'_, DocumentRegistry>,
    recovery: State<'_, RecoveryStore>,
    doc_id: String,
    token: String,
    generation: u64,
    ops: Vec<DocOp>,
) -> Result<Option<DocumentUpdate>, String> {
    let app = window.app_handle();
    let record = reg.apply_draft(&doc_id, window.label(), &token, generation, ops)?;
    let update = record.map(|record| build_update(&reg, &doc_id, "edit", &record));
    if let Some(update) = &update {
        let _ = app.emit(EV_DOC_UPDATED, update);
    }
    maintain_recovery(&window, &reg, &recovery, &doc_id);
    emit_draft_state(app, &reg, &doc_id);
    Ok(update)
}

#[tauri::command]
fn documents_apply_localized(
    app: tauri::AppHandle,
    reg: State<'_, DocumentRegistry>,
    doc_id: String,
    base_revision: u64,
    ops: Vec<DocOp>,
) -> Result<DocumentUpdate, String> {
    let record = reg
        .apply_localized_transaction(&doc_id, &WireTransaction { base_revision, ops })
        .map_err(|error| error.to_string())?;
    let update = build_update(&reg, &doc_id, "edit", &record);
    let _ = app.emit(EV_DOC_UPDATED, &update);
    Ok(update)
}

/// Debounced recovery snapshot (FR-006). Content is the canonical buffer as
/// it stands; `draft` carries a modified inline draft (ADR-008) if active.
#[tauri::command]
fn documents_recovery_snapshot(
    window: tauri::Window,
    reg: State<'_, DocumentRegistry>,
    recovery: State<'_, RecoveryStore>,
    doc_id: String,
    draft: Option<String>,
) -> Result<Option<RecoveryInfo>, String> {
    let _ = draft; // Legacy argument; only registry-owned draft state is durable.
    recovery.persist_document(&reg, &doc_id).map_err(|error| {
        let message = format!("Recovery could not be saved: {error}");
        let _ = window.emit_to(
            tauri::EventTarget::window(window.label()),
            "lifecycle-error",
            &message,
        );
        message
    })
}

// ---------------------------------------------------------------------------
// Recovery commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn recovery_list(recovery: State<'_, RecoveryStore>) -> Vec<RecoveryInfo> {
    recovery.list_for_restore()
}

#[tauri::command]
fn recovery_discard(recovery: State<'_, RecoveryStore>, key: String) {
    recovery.remove(&key);
}

#[tauri::command]
fn recovery_restore(
    recovery: State<'_, RecoveryStore>,
    reg: State<'_, DocumentRegistry>,
    key: String,
    visual: bool,
) -> Result<documents::recovery::RestoredDocument, String> {
    recovery.restore_document(&key, &reg, visual)
}

// ---------------------------------------------------------------------------
// Settings commands
// ---------------------------------------------------------------------------

struct BenchmarkClock {
    start: std::time::Instant,
    enabled: bool,
}
#[tauri::command]
fn benchmark_clock(clock: State<'_, BenchmarkClock>) -> Option<f64> {
    clock
        .enabled
        .then(|| clock.start.elapsed().as_secs_f64() * 1000.0)
}
#[tauri::command]
fn benchmark_ready(clock: State<'_, BenchmarkClock>) -> Result<f64, String> {
    if !clock.enabled {
        return Err("Benchmark mode disabled".into());
    }
    let elapsed = clock.start.elapsed().as_secs_f64() * 1000.0;
    println!("m5-benchmark-ready:{elapsed}");
    Ok(elapsed)
}
#[tauri::command]
fn benchmark_report(
    app: tauri::AppHandle,
    clock: State<'_, BenchmarkClock>,
    result: serde_json::Value,
) -> Result<(), String> {
    if !clock.enabled {
        return Err("Benchmark reporting requires --m5-benchmark".into());
    }
    println!("m5-benchmark:{}", result);
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn export_image(
    window: tauri::WebviewWindow,
    scopes: State<'_, workspace::WorkspaceScopes>,
    reg: State<'_, DocumentRegistry>,
    doc_id: String,
    href: String,
) -> Result<String, String> {
    let doc = reg.snapshot(&doc_id).ok_or("Unknown document")?;
    export::image_uri(
        PathBuf::from(
            doc.path
                .ok_or("Save document before embedding local images")?,
        )
        .as_path(),
        &href,
        scopes.root(window.label()).as_deref(),
    )
}

#[tauri::command]
async fn export_save(
    window: tauri::WebviewWindow,
    scopes: State<'_, workspace::WorkspaceScopes>,
    reg: State<'_, DocumentRegistry>,
    doc_id: String,
    format: String,
    html: String,
    blocks: Vec<export::Block>,
) -> Result<Option<String>, String> {
    let doc = reg.snapshot(&doc_id).ok_or("Unknown document")?;
    if !["html", "docx"].contains(&format.as_str()) {
        return Err("Unsupported export format".into());
    }
    if html.len() > 24 * 1024 * 1024 {
        return Err("HTML export exceeds 24 MiB".into());
    }
    let source = doc.path.map(PathBuf::from);
    let bytes = if format == "html" {
        html.into_bytes()
    } else {
        export::docx(
            &blocks,
            source.as_deref(),
            scopes.root(window.label()).as_deref(),
        )?
    };
    let suggested = format!(
        "{}.{}",
        source
            .as_deref()
            .and_then(|p| p.file_stem())
            .unwrap_or(std::ffi::OsStr::new("document"))
            .to_string_lossy(),
        format
    );
    let chosen = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("Export document")
            .set_file_name(suggested)
            .add_filter("Export", &[format.as_str()])
            .save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = chosen else {
        return Ok(None);
    };
    if !path
        .extension()
        .is_some_and(|ext| ext == "html" || ext == "docx")
    {
        return Err("Export filename must end in .html or .docx".into());
    }
    if source
        .as_deref()
        .is_some_and(|p| p.canonicalize().ok() == path.canonicalize().ok() && path.exists())
    {
        return Err("Export cannot replace the source document".into());
    }
    let destination = path.clone();
    tokio::task::spawn_blocking(move || export::write(&destination, &bytes))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn export_preview(
    app: tauri::AppHandle,
    previews: State<'_, export::PrintPreviews>,
    html: String,
) -> Result<(), String> {
    if html.len() > 24 * 1024 * 1024 {
        return Err("Print preview exceeds 24 MiB".into());
    }
    let label = format!(
        "print-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    {
        let mut active = previews.0.lock().map_err(|_| "Print preview lock")?;
        if active.len() >= 4 {
            return Err("Close a print preview before opening another".into());
        }
        active.insert(label.clone(), html);
    }
    let result = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html?exportPreview=1".into()),
    )
    .title("Marquellium — Print / Save PDF")
    .inner_size(900.0, 800.0)
    .build();
    if let Err(e) = result {
        previews
            .0
            .lock()
            .map_err(|_| "Print preview lock")?
            .remove(&label);
        return Err(e.to_string());
    }
    Ok(())
}
#[tauri::command]
fn export_preview_content(
    window: tauri::WebviewWindow,
    previews: State<'_, export::PrintPreviews>,
) -> Result<String, String> {
    previews
        .0
        .lock()
        .map_err(|_| "Print preview lock")?
        .get(window.label())
        .cloned()
        .ok_or("No print preview for this window".into())
}
#[tauri::command]
fn export_print(window: tauri::WebviewWindow) -> Result<(), String> {
    if !window.label().starts_with("print-") {
        return Err("Print is available in the dedicated preview".into());
    }
    window.print().map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_get(store: State<'_, SettingsStore>) -> Settings {
    // Normalizing on read self-heals a previously persisted zeroed payload
    // (e.g. sidebar width 0) without touching the file until the next save.
    store.load().normalized()
}

#[tauri::command]
fn settings_set(
    app: tauri::AppHandle,
    store: State<'_, SettingsStore>,
    settings: Settings,
) -> Result<(), String> {
    let settings = settings.normalized();
    store.save(&settings).map_err(|e| e.to_string())?;
    app.emit("settings-changed", &settings)
        .map_err(|e| e.to_string())
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
    paths
        .iter()
        .map(|p| std::path::Path::new(p).is_file())
        .collect()
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
async fn dialog_open_folder(
    window: tauri::WebviewWindow,
    scopes: State<'_, workspace::WorkspaceScopes>,
) -> Result<Option<String>, String> {
    let chosen = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Open Workspace Folder")
            .pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    chosen
        .map(|p| {
            scopes
                .grant(window.label(), &p)
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|e| e.to_string())
        })
        .transpose()
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
fn workspace_root(
    window: tauri::WebviewWindow,
    scopes: State<'_, workspace::WorkspaceScopes>,
) -> Option<String> {
    scopes
        .root(window.label())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn workspace_list_dir(
    window: tauri::WebviewWindow,
    scopes: State<'_, workspace::WorkspaceScopes>,
    root: String,
    exclusions: Vec<String>,
) -> Result<Vec<workspace::DirEntry>, String> {
    let scope = scopes
        .root(window.label())
        .ok_or("Choose a workspace folder first")?;
    workspace::list_scoped(&scope, &PathBuf::from(root), &exclusions).map_err(|e| e.to_string())
}

#[tauri::command]
async fn workspace_search(
    window: tauri::WebviewWindow,
    scopes: State<'_, workspace::WorkspaceScopes>,
    query: String,
    exclusions: Vec<String>,
) -> Result<workspace::SearchResults, String> {
    let scope = scopes
        .root(window.label())
        .ok_or("Choose a workspace folder first")?;
    tauri::async_runtime::spawn_blocking(move || workspace::search(&scope, &query, &exclusions))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalLinkTarget {
    path: String,
    fragment: Option<String>,
    content: Option<String>,
}

#[tauri::command]
fn workspace_link(
    window: tauri::WebviewWindow,
    scopes: State<'_, workspace::WorkspaceScopes>,
    reg: State<'_, DocumentRegistry>,
    doc_id: String,
    href: String,
    read_content: bool,
) -> Result<LocalLinkTarget, String> {
    let doc = reg.snapshot(&doc_id).ok_or("Unknown document")?;
    let path = doc
        .path
        .ok_or("Save the document to resolve relative links")?;
    let root = scopes.root(window.label());
    let (target, fragment) =
        workspace::resolve_link(PathBuf::from(path).as_path(), root.as_deref(), &href)?;
    let content = if read_content
        && fragment.is_some()
        && target
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                ["md", "markdown", "txt"]
                    .iter()
                    .any(|allowed| ext.eq_ignore_ascii_case(allowed))
            }) {
        if std::fs::metadata(&target).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
            return Err("Anchor validation limit is 1 MiB per target".into());
        }
        Some(std::fs::read_to_string(&target).map_err(|e| e.to_string())?)
    } else {
        None
    };
    Ok(LocalLinkTarget {
        path: target.to_string_lossy().into_owned(),
        fragment,
        content,
    })
}

#[tauri::command]
async fn assets_paste_image(
    app: tauri::AppHandle,
    reg: State<'_, DocumentRegistry>,
    lifecycle: State<'_, lifecycle::Lifecycle>,
    doc_id: String,
    folder: String,
) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    if lifecycle.is_active() {
        return Err(
            "Navigation or closing is in progress; retry image paste after it finishes".into(),
        );
    }
    let path = reg
        .snapshot(&doc_id)
        .and_then(|doc| doc.path)
        .ok_or("Save the document before pasting an image")?;
    tauri::async_runtime::spawn_blocking(move || {
        let image = app.clipboard().read_image().map_err(|e| e.to_string())?;
        assets::persist_rgba(
            PathBuf::from(path).as_path(),
            &folder,
            image.width(),
            image.height(),
            image.rgba(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
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

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new as &dyn IsMenuItem<tauri::Wry>,
            &open,
            &save,
            &save_as,
            &MenuItem::with_id(app, "export", "Export…", true, Some("Shift+CmdOrCtrl+E"))?,
            &PredefinedMenuItem::separator(app)?,
            &close_tab,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &MenuItem::with_id(
                app,
                "preferences",
                "Preferences…",
                true,
                Some("CmdOrCtrl+,"),
            )? as &dyn IsMenuItem<tauri::Wry>,
            &MenuItem::with_id(app, "history:undo", "Undo", true, Some("CmdOrCtrl+Z"))?
                as &dyn IsMenuItem<tauri::Wry>,
            &MenuItem::with_id(app, "history:redo", "Redo", true, Some("Shift+CmdOrCtrl+Z"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "find", "Find / Replace…", true, Some("CmdOrCtrl+F"))?,
        ],
    )?;

    let read = MenuItem::with_id(app, "mode:read", "Read", true, Some("CmdOrCtrl+1"))?;
    let source = MenuItem::with_id(app, "mode:source", "Source", true, Some("CmdOrCtrl+2"))?;
    let split = MenuItem::with_id(app, "mode:split", "Split", true, Some("CmdOrCtrl+3"))?;
    let visual = MenuItem::with_id(app, "mode:visual", "Visual", true, Some("CmdOrCtrl+4"))?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &read as &dyn IsMenuItem<tauri::Wry>,
            &source,
            &split,
            &visual,
        ],
    )?;

    let new_window = MenuItem::with_id(app, "new_window", "New Window", true, None::<&str>)?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &new_window as &dyn IsMenuItem<tauri::Wry>,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::minimize(app, None)?,
            #[cfg(not(target_os = "linux"))]
            &PredefinedMenuItem::maximize(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ],
    )?;
    let menu = Menu::with_items(
        app,
        &[&file as &dyn IsMenuItem<tauri::Wry>, &edit, &view, &window],
    )?;
    app.set_menu(menu)?;
    #[cfg(target_os = "macos")]
    window.set_as_windows_menu_for_nsapp()?;
    Ok(())
}

/// Debounced disk-change handler for open documents.
async fn drain_watcher(
    app: tauri::AppHandle,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<PathBuf>,
) {
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
                for id in reg.get() {
                    if let Some(auto_reload) = reg.observe_disk_change(&id, p) {
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
enum CloseStage {
    Requested,
    CoordinatorStart,
    Resolved,
    Cancelled,
}

/// Contains lifecycle stages only: never document text or filesystem paths.
#[tauri::command]
fn close_trace(window: tauri::Window, stage: CloseStage) {
    eprintln!("close-flow window={} stage={stage:?}", window.label());
}

/// Only invoked after the frontend coordinator resolves unsaved work.
/// Destroy bypasses a second close request and its prevention handshake.
#[tauri::command]
async fn confirm_window_close(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<bool, String> {
    lifecycle::start(
        app,
        window.label().into(),
        lifecycle::Trigger::CloseWindow,
        Vec::new(),
    )
    .await
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
    let window_focus: Vec<_> = app
        .webview_windows()
        .values()
        .map(|window| (window.label().to_string(), window.is_focused()))
        .collect();
    // Window identities/focus only, never document text or filesystem paths.
    eprintln!("close-flow quit focus={window_focus:?}");
    let caller = lifecycle::quit_window(
        window_focus
            .into_iter()
            .map(|(label, focused)| (label, focused.unwrap_or(false)))
            .collect(),
    );
    if let Some(caller) = caller {
        tauri::async_runtime::spawn(async move {
            if let Err(error) = lifecycle::start(
                app.clone(),
                caller.clone(),
                lifecycle::Trigger::Quit,
                Vec::new(),
            )
            .await
            {
                if let Some(window) = app.get_webview_window(&caller) {
                    let _ = window.emit_to(
                        tauri::EventTarget::window(&caller),
                        "lifecycle-error",
                        error,
                    );
                }
            }
        });
    } else {
        app.exit(0);
    }
}

fn app_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let benchmark_state = BenchmarkClock {
        start: std::time::Instant::now(),
        enabled: std::env::args().any(|a| a == "--m5-benchmark"),
    };
    if std::env::args().any(|arg| arg == "--mermaid-preview-worker") {
        preview::run_worker();
        return;
    }
    if std::env::args().any(|arg| arg == "--mermaid-preview-check") {
        preview::check_from_stdin();
        return;
    }
    #[cfg(target_os = "linux")]
    if let Ok(cwd) = std::env::current_dir() {
        let origin = file_open::launch_directory(&cwd, std::env::var_os("APPIMAGE").is_some(), file_open::appimage_origin());
        if origin != cwd {
            if let Err(error) = std::env::set_current_dir(origin) {
                eprintln!("Cannot restore AppImage launch directory: {error}");
            }
        }
    }
    let data_dir = app_data_dir();
    let incoming = file_open::FileOpenQueue::default();
    if let Err(error) = file_open::startup(&incoming) {
        eprintln!("File-open startup: {error}");
    }
    let mut context = app_context();
    // Isolated acceptance data must not send requests to a normal user instance.
    if std::env::var_os("MARKDOWN_VIEWER_DATA_DIR").is_some() {
        use sha2::{Digest, Sha256};
        let digest = hex::encode(Sha256::digest(data_dir.to_string_lossy().as_bytes()));
        context.config_mut().identifier =
            format!("com.markdownviewer.desktop.test{}", &digest[..12]);
    }
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<PathBuf>();
    let tx_for_state = tx.clone();
    let media = MediaScope::default();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths = file_open::arguments(args, std::path::Path::new(&cwd));
            if let Err(error) = file_open::deliver(app, paths) {
                eprintln!("File-open delivery: {error}");
            }
        }))
        .manage(incoming)
        .manage(benchmark_state)
        .manage(DocumentRegistry::new())
        .manage(workspace::WorkspaceScopes::default())
        .manage(preview::PreviewService::default())
        .manage(lifecycle::Lifecycle::default())
        .manage(RecoveryStore::new(data_dir.join("recovery")))
        .manage(export::PrintPreviews::default())
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
                *app.state::<WatchState>()
                    .watcher
                    .lock()
                    .expect("watch lock") = Some(w);
            }
            tauri::async_runtime::spawn(drain_watcher(handle, rx));

            #[cfg(target_os = "macos")]
            macos_termination::install(app.handle()).map_err(std::io::Error::other)?;
            build_menu(app.handle())?;
            app.on_menu_event(|app, event| {
                if app.state::<lifecycle::Lifecycle>().is_active() && event.id.0 != "quit" {
                    return; // Native menus cannot mutate the participant set during resolution.
                }
                // Quit is application-wide, including while no window has focus.
                if event.id.0 == "quit" {
                    eprintln!("close-flow quit source=native-menu");
                    quit_app(app.clone());
                    return;
                }
                for window in app.webview_windows().values() {
                    if window.is_focused().unwrap_or(false) {
                        let _ = window.emit_to(
                            tauri::EventTarget::window(window.label()),
                            EV_MENU_COMMAND,
                            MenuCmd {
                                id: event.id.0.clone(),
                            },
                        );
                        break;
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                eprintln!("close-flow window={} stage=Destroyed", window.label());
                window
                    .state::<workspace::WorkspaceScopes>()
                    .revoke(window.label());
                file_open::window_destroyed(window.app_handle(), window.label());
                if let Ok(mut previews) = window.state::<export::PrintPreviews>().0.lock() {
                    previews.remove(window.label());
                }
                window
                    .state::<preview::PreviewService>()
                    .cancel(window.label(), None);
                window
                    .state::<lifecycle::Lifecycle>()
                    .window_destroyed(window.label());
                let reg = window.state::<DocumentRegistry>();
                for doc_id in reg.detach_window_drafts(window.label()) {
                    let recovery = window.state::<RecoveryStore>();
                    if let Err(error) = recovery.persist_document(&reg, &doc_id) {
                        eprintln!("draft recovery failed: {error}");
                    }
                    emit_draft_state(window.app_handle(), &reg, &doc_id);
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Tauri emits tauri://close-requested to this window. Stay
                // open until its frontend resolves Save/Discard/Cancel.
                eprintln!(
                    "close-flow window={} stage=NativeCloseRequested",
                    window.label()
                );
                api.prevent_close();
            }
        });

    builder
        .invoke_handler(tauri::generate_handler![
            lifecycle::lifecycle_begin,
            lifecycle::lifecycle_reply,
            preview::previews_mermaid,
            preview::previews_cancel,
            app_info,
            file_open::file_open_next,
            file_open::file_open_ack,
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
            drafts_acquire,
            drafts_update,
            drafts_release,
            drafts_info,
            drafts_resume,
            drafts_apply,
            documents_apply_localized,
            documents_recovery_snapshot,
            recovery_list,
            recovery_discard,
            recovery_restore,
            benchmark_clock,
            benchmark_ready,
            benchmark_report,
            export_image,
            export_save,
            export_preview,
            export_preview_content,
            export_print,
            settings_get,
            settings_set,
            session_get,
            session_set,
            files_exist,
            workspace_list_dir,
            workspace_search,
            workspace_root,
            workspace_link,
            assets_paste_image,
            path_in_scope,
            close_trace,
            confirm_window_close,
            quit_app,
            open_external_url
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { ref urls } = event {
                let paths = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .collect();
                if let Err(error) = file_open::deliver(app, paths) {
                    eprintln!("File-open OS event: {error}");
                }
            }
            // OS/Dock Quit must resolve the same unsaved-work flow as menu Quit.
            // Allow the normal exit when the last resolved window is gone.
            if let tauri::RunEvent::ExitRequested {
                api, code: None, ..
            } = event
            {
                if !app.webview_windows().is_empty() {
                    api.prevent_exit();
                    eprintln!("close-flow quit source=os-exit-requested");
                    quit_app(app.clone());
                }
            }
        });
}
