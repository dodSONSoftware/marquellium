//! One application-wide resolution transaction. No windows are destroyed until
//! every owner has flushed and every affected document has been resolved.
use crate::documents::{DocumentRegistry, RecoveryStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Trigger {
    Quit,
    CloseWindow,
    CloseTab,
    ModeSwitch,
    TabSwitch,
    ReloadDocument,
}

struct Pending {
    window: String,
    reply: oneshot::Sender<Result<Value, String>>,
}
#[derive(Default)]
pub struct Lifecycle {
    active: AtomicBool,
    counter: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
}

struct ActiveTransaction<'a>(&'a AtomicBool);
impl Drop for ActiveTransaction<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Lifecycle {
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
    fn begin(&self) -> Result<ActiveTransaction<'_>, String> {
        if self.active.swap(true, Ordering::SeqCst) {
            return Err("another navigation or close request is already being resolved".into());
        }
        Ok(ActiveTransaction(&self.active))
    }

    pub fn reply(
        &self,
        window: &str,
        id: u64,
        result: Result<Value, String>,
    ) -> Result<(), String> {
        let mut pending = self.pending.lock().map_err(|e| e.to_string())?;
        if !pending
            .get(&id)
            .is_some_and(|request| request.window == window)
        {
            return Err("expired lifecycle request or wrong window".into());
        }
        let request = pending.remove(&id).ok_or("expired lifecycle request")?;
        request
            .reply
            .send(result)
            .map_err(|_| "lifecycle request ended".into())
    }
    pub fn window_destroyed(&self, window: &str) {
        let mut pending = self.pending.lock().expect("lifecycle requests");
        let ids: Vec<_> = pending
            .iter()
            .filter(|(_, p)| p.window == window)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            if let Some(p) = pending.remove(&id) {
                let _ = p
                    .reply
                    .send(Err("draft owner/window closed during resolution".into()));
            }
        }
    }
    async fn request(
        &self,
        app: &tauri::AppHandle,
        window: &str,
        action: &str,
        transaction: u64,
        body: Value,
    ) -> Result<Value, String> {
        let target = app
            .get_webview_window(window)
            .ok_or("lifecycle owner window is unavailable")?;
        let id = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().map_err(|e| e.to_string())?.insert(
            id,
            Pending {
                window: window.into(),
                reply: sender,
            },
        );
        let outcome = async {
            if matches!(action, "resolve-draft" | "resolve-canonical") {
                // Focus alone does not restore a miniaturized macOS window.
                // Keep the pending-request cleanup below active on failure.
                target
                    .unminimize()
                    .map_err(|e| format!("could not restore resolution window: {e}"))?;
                target
                    .show()
                    .map_err(|e| format!("could not show resolution window: {e}"))?;
                target
                    .set_focus()
                    .map_err(|e| format!("could not focus resolution window: {e}"))?;
            }
            target
                .emit_to(
                    tauri::EventTarget::window(window),
                    "lifecycle-request",
                    json!({ "id": id, "transaction": transaction, "action": action, "body": body }),
                )
                .map_err(|e| e.to_string())?;
            let budget = if action == "prepare" { 15 } else { 600 };
            tokio::time::timeout(std::time::Duration::from_secs(budget), receiver)
                .await
                .map_err(|_| {
                    "lifecycle response timed out; all surviving windows remain open".to_string()
                })?
                .map_err(|_| "lifecycle response lost".to_string())?
        }
        .await;
        self.pending.lock().map_err(|e| e.to_string())?.remove(&id);
        outcome
    }
}

fn windows(app: &tauri::AppHandle) -> Vec<String> {
    let mut windows: Vec<_> = app.webview_windows().keys().cloned().collect();
    windows.sort();
    windows
}

pub fn quit_window(mut candidates: Vec<(String, bool)>) -> Option<String> {
    candidates.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
    candidates.into_iter().next().map(|(name, _)| name)
}

pub async fn start(
    app: tauri::AppHandle,
    caller: String,
    trigger: Trigger,
    selected: Vec<String>,
) -> Result<bool, String> {
    let lifecycle = app.state::<Lifecycle>();
    let _transaction = lifecycle.begin()?;
    let transaction = lifecycle.counter.fetch_add(1, Ordering::SeqCst) + 1;
    let participants = windows(&app);
    let host = NativeHost {
        app: &app,
        transaction,
        registry: app.state(),
        recovery: app.state(),
        lifecycle: app.state(),
    };
    let result = resolve(&host, &caller, trigger, selected, &participants).await;
    for name in &participants {
        if let Some(window) = app.get_webview_window(name) {
            let _ = window.emit_to(
                tauri::EventTarget::window(name),
                "lifecycle-release",
                json!({ "transaction": transaction }),
            );
        }
    }
    if matches!(
        trigger,
        Trigger::ModeSwitch | Trigger::TabSwitch | Trigger::ReloadDocument
    ) && result.as_ref().is_ok_and(|allowed| *allowed)
    {
        if let Some(window) = app.get_webview_window(&caller) {
            let _ = window.set_focus();
        }
    }
    result
}

trait Host: Sync {
    fn registry(&self) -> &DocumentRegistry;
    fn recovery(&self) -> &RecoveryStore;
    fn windows(&self) -> Vec<String>;
    fn request<'a>(
        &'a self,
        window: &'a str,
        action: &'a str,
        body: Value,
    ) -> impl std::future::Future<Output = Result<Value, String>> + Send + 'a;
    fn close(&self, window: &str) -> Result<(), String>;
    fn quit(&self);
    fn reloaded(&self, id: &str, record: &crate::documents::TransactionRecord);
}
struct NativeHost<'a> {
    app: &'a tauri::AppHandle,
    transaction: u64,
    registry: tauri::State<'a, DocumentRegistry>,
    recovery: tauri::State<'a, RecoveryStore>,
    lifecycle: tauri::State<'a, Lifecycle>,
}
impl Host for NativeHost<'_> {
    fn registry(&self) -> &DocumentRegistry {
        &self.registry
    }
    fn recovery(&self) -> &RecoveryStore {
        &self.recovery
    }
    fn windows(&self) -> Vec<String> {
        windows(self.app)
    }
    async fn request(&self, window: &str, action: &str, body: Value) -> Result<Value, String> {
        self.lifecycle
            .request(self.app, window, action, self.transaction, body)
            .await
    }
    fn close(&self, window: &str) -> Result<(), String> {
        self.app
            .get_webview_window(window)
            .ok_or("window closed before execution")?
            .destroy()
            .map_err(|e| e.to_string())
    }
    fn quit(&self) {
        self.app.exit(0);
    }
    fn reloaded(&self, id: &str, record: &crate::documents::TransactionRecord) {
        let _ = self.app.emit(
            crate::EV_DOC_UPDATED,
            crate::build_update(&self.registry, id, "edit", record),
        );
    }
}

async fn resolve(
    host: &impl Host,
    caller: &str,
    trigger: Trigger,
    selected: Vec<String>,
    participants: &[String],
) -> Result<bool, String> {
    let registry = host.registry();
    let recovery = host.recovery();
    let mut views = HashMap::<String, Vec<String>>::new();
    // Freeze every view before asking any owner to resolve work. Cancel never
    // executes an earlier window's close, and repeated triggers cannot replace us.
    for name in participants {
        let reply = host.request(name, "prepare", json!({})).await?;
        let ids: Vec<String> = serde_json::from_value(reply).map_err(|e| e.to_string())?;
        views.insert(name.clone(), ids);
    }
    let mut affected = if trigger == Trigger::Quit {
        registry.get()
    } else if trigger == Trigger::CloseWindow {
        views.get(caller).cloned().unwrap_or_default()
    } else {
        selected
    };
    affected.sort();
    affected.dedup();
    let summary: Vec<String> = affected
        .iter()
        .enumerate()
        .map(|(index, id)| {
            registry
                .snapshot(id)
                .and_then(|s| s.path)
                .unwrap_or_else(|| format!("Untitled {}", index + 1))
        })
        .collect();
    let mut draft_discards = Vec::new();
    // All drafts precede every canonical prompt, including on different docs.
    for (index, id) in affected.iter().enumerate() {
        if let Some(lease) = registry.draft_info(id) {
            let owner = lease.owner_window.as_deref().unwrap_or(caller);
            let reply = host
                .request(
                    owner,
                    "resolve-draft",
                    json!({ "trigger": trigger, "displayName": summary[index], "lease": lease, "summary": summary }),
                )
                .await?;
            match reply.as_str() {
                Some("cancel") => return Ok(false),
                Some("discard") => draft_discards.push(lease),
                Some("applied") if registry.draft_info(id).is_none() => {}
                _ => return Err("draft owner did not resolve the expected session".into()),
            }
        }
    }
    let mut discarded = Vec::new();
    let mut revisions = HashMap::new();
    let navigation = matches!(trigger, Trigger::ModeSwitch | Trigger::TabSwitch);
    for (index, id) in affected.iter().enumerate() {
        let Some(snapshot) = registry.snapshot(id) else {
            continue;
        };
        revisions.insert(id.clone(), snapshot.revision);
        let shared = views.values().filter(|ids| ids.contains(id)).count() > 1;
        if snapshot.dirty
            && !navigation
            && (trigger == Trigger::Quit || trigger == Trigger::ReloadDocument || !shared)
        {
            let reply = host
                .request(
                    caller,
                    "resolve-canonical",
                    json!({ "trigger": trigger, "displayName": summary[index], "snapshot": snapshot, "summary": summary }),
                )
                .await?;
            match reply.as_str() {
                Some("cancel") => return Ok(false),
                Some("discard") => discarded.push(id.clone()),
                Some("saved") if registry.snapshot(id).is_some_and(|s| !s.dirty) => {}
                _ => return Err("canonical document changed during resolution".into()),
            }
        }
    }
    if host.windows() != participants
        || revisions.iter().any(|(id, revision)| {
            registry
                .snapshot(id)
                .is_none_or(|s| s.revision != *revision)
        })
    {
        return Err(
            "windows or documents changed during resolution; retry with all work preserved".into(),
        );
    }
    // Explicit Discard choices are deferred until the entire request has no
    // remaining Cancel steps. Earlier Cancel preserves still-open draft text.
    for lease in draft_discards {
        if let Some(owner) = lease.owner_window.as_deref() {
            host.request(
                owner,
                "discard-draft",
                json!({ "token": lease.token, "docId": lease.doc_id }),
            )
            .await?;
        } else {
            registry.discard_orphan(&lease.doc_id, &lease.token)?;
        }
        recovery
            .persist_document(registry, &lease.doc_id)
            .map_err(|e| e.to_string())?;
    }
    if host.windows() != participants
        || revisions.iter().any(|(id, revision)| {
            registry
                .snapshot(id)
                .is_none_or(|snapshot| snapshot.revision != *revision)
        })
    {
        return Err("state changed before execution; no window was closed".into());
    }
    if trigger == Trigger::ReloadDocument {
        for id in &affected {
            let record = registry.reload_from_disk(
                id,
                *revisions.get(id).ok_or("missing reload base")?,
                true,
            )?;
            recovery
                .persist_document(registry, id)
                .map_err(|e| e.to_string())?;
            host.reloaded(id, &record);
        }
        return Ok(true);
    }
    let closing = match trigger {
        Trigger::Quit => participants.to_vec(),
        Trigger::CloseWindow => vec![caller.to_string()],
        _ => Vec::new(),
    };
    let release_view = |id: &str| -> Result<(), String> {
        if registry.release_view(id)? == 0 {
            if let Some(snapshot) = registry.snapshot(id) {
                let key = recovery.document_key(&snapshot.path.map(std::path::PathBuf::from), id);
                if !snapshot.dirty || discarded.iter().any(|discarded| discarded == id) {
                    recovery.remove(&key);
                }
            }
            registry.dispose(id);
        }
        Ok(())
    };
    if trigger == Trigger::CloseTab {
        for id in &affected {
            release_view(id)?;
        }
    }
    for name in &closing {
        // Release only at execution, while the input barrier is still held.
        for id in views.get(name).into_iter().flatten() {
            release_view(id)?;
        }
        host.close(name)?;
    }
    if trigger == Trigger::Quit {
        host.quit();
    }
    Ok(true)
}

#[tauri::command]
pub async fn lifecycle_begin(
    app: tauri::AppHandle,
    window: tauri::Window,
    trigger: Trigger,
    doc_ids: Vec<String>,
) -> Result<bool, String> {
    start(app, window.label().into(), trigger, doc_ids).await
}
#[tauri::command]
pub fn lifecycle_reply(
    service: tauri::State<'_, Lifecycle>,
    window: tauri::Window,
    id: u64,
    value: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    service.reply(
        window.label(),
        id,
        error.map_or_else(|| Ok(value.unwrap_or(Value::Null)), Err),
    )
}

#[cfg(test)]
mod tests;
