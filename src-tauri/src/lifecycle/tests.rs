use super::*;
use crate::documents::{DocOp, DraftKind, DraftOpening, DraftUpdate, WireTransaction};
use std::collections::VecDeque;

#[test]
fn repeated_requests_cannot_replace_an_active_transaction() {
    let lifecycle = Lifecycle::default();
    let transaction = lifecycle.begin().unwrap();
    assert!(lifecycle.begin().is_err());
    assert!(lifecycle.active.load(Ordering::SeqCst));
    drop(transaction);
    assert!(lifecycle.begin().is_ok());
}

#[test]
fn quit_uses_a_stable_window_even_without_keyboard_focus() {
    assert_eq!(
        quit_window(vec![("b".into(), false), ("a".into(), false)]).as_deref(),
        Some("a")
    );
    assert_eq!(
        quit_window(vec![("a".into(), false), ("b".into(), true)]).as_deref(),
        Some("b")
    );
    assert!(quit_window(Vec::new()).is_none());
}

struct TestHost {
    registry: DocumentRegistry,
    recovery: RecoveryStore,
    _dir: tempfile::TempDir,
    windows: Mutex<Vec<String>>,
    views: HashMap<String, Vec<String>>,
    choices: Mutex<VecDeque<String>>,
    events: Mutex<Vec<(String, String, String)>>,
    closed: Mutex<Vec<String>>,
    quit: AtomicBool,
    change_windows: AtomicBool,
}
impl TestHost {
    fn new(choices: &[&str]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let registry = DocumentRegistry::new();
        let mut ids = Vec::new();
        for name in ["one.md", "two.md"] {
            let path = dir.path().join(name);
            std::fs::write(&path, "original").unwrap();
            let (text, bom, newline, revision) =
                crate::documents::service::open_document(&path, false).unwrap();
            let id = registry
                .insert_opened(&path, text, bom, newline, revision)
                .unwrap();
            registry
                .apply_transaction(
                    &id,
                    &WireTransaction {
                        base_revision: 0,
                        ops: vec![DocOp {
                            start_byte: 0,
                            end_byte: 8,
                            text: "modified".into(),
                        }],
                    },
                )
                .unwrap();
            ids.push(id);
        }
        let views = HashMap::from([("a".into(), vec![ids[0].clone()]), ("b".into(), ids)]);
        for id in views.values().flatten() {
            registry.acquire_view(id).unwrap();
        }
        Self {
            registry,
            recovery: RecoveryStore::new(dir.path().join("recovery")),
            _dir: dir,
            windows: Mutex::new(vec!["a".into(), "b".into()]),
            views,
            choices: Mutex::new(choices.iter().map(|s| s.to_string()).collect()),
            events: Mutex::new(Vec::new()),
            closed: Mutex::new(Vec::new()),
            quit: AtomicBool::new(false),
            change_windows: AtomicBool::new(false),
        }
    }
    fn id(&self) -> String {
        self.views["a"][0].clone()
    }
    fn draft(&self) {
        self.draft_for(&self.id());
    }
    fn draft_for(&self, id: &str) {
        let id = id.to_string();
        let lease = self
            .registry
            .acquire_draft(
                &id,
                "b",
                DraftOpening {
                    base_revision: 1,
                    start_byte: 0,
                    end_byte: 8,
                    opening_text: "modified".into(),
                    kind: DraftKind::Source,
                },
            )
            .unwrap();
        self.registry
            .update_draft(
                &id,
                "b",
                &lease.token,
                DraftUpdate {
                    generation: 1,
                    text: "local draft".into(),
                    valid: true,
                },
            )
            .unwrap();
        self.recovery.persist_document(&self.registry, &id).unwrap();
    }
}
impl Host for TestHost {
    fn registry(&self) -> &DocumentRegistry {
        &self.registry
    }
    fn recovery(&self) -> &RecoveryStore {
        &self.recovery
    }
    fn windows(&self) -> Vec<String> {
        self.windows.lock().unwrap().clone()
    }
    async fn request(&self, window: &str, action: &str, body: Value) -> Result<Value, String> {
        let id = body["snapshot"]["docId"]
            .as_str()
            .or(body["lease"]["docId"].as_str())
            .or(body["docId"].as_str())
            .unwrap_or("")
            .to_string();
        self.events
            .lock()
            .unwrap()
            .push((window.into(), action.into(), id.clone()));
        if action == "prepare" {
            if self.change_windows.swap(false, Ordering::SeqCst) {
                self.windows.lock().unwrap().push("new-window".into());
            }
            return Ok(json!(self.views.get(window).ok_or("window unavailable")?));
        }
        if action == "discard-draft" {
            self.registry
                .release_draft(&id, window, body["token"].as_str().unwrap())?;
            return Ok(json!("discarded"));
        }
        let choice = self
            .choices
            .lock()
            .unwrap()
            .pop_front()
            .ok_or("missing test choice")?;
        if choice == "saved" {
            self.registry
                .save_to_disk(&id, None)
                .map_err(|e| e.to_string())?;
        }
        if choice == "applied" {
            let lease = self.registry.draft_info(&id).ok_or("missing lease")?;
            self.registry.apply_draft(
                &id,
                window,
                &lease.token,
                lease.generation,
                vec![DocOp {
                    start_byte: lease.opening.start_byte,
                    end_byte: lease.opening.end_byte,
                    text: lease.text,
                }],
            )?;
        }
        if choice == "change-before-discard" {
            let snapshot = self.registry.snapshot(&id).unwrap();
            self.registry
                .apply_transaction(
                    &id,
                    &WireTransaction {
                        base_revision: snapshot.revision,
                        ops: vec![DocOp {
                            start_byte: 0,
                            end_byte: 0,
                            text: "remote".into(),
                        }],
                    },
                )
                .unwrap();
            return Ok(json!("discard"));
        }
        Ok(json!(choice))
    }
    fn close(&self, window: &str) -> Result<(), String> {
        self.closed.lock().unwrap().push(window.into());
        Ok(())
    }
    fn quit(&self) {
        self.quit.store(true, Ordering::SeqCst);
    }
    fn reloaded(&self, _: &str, _: &crate::documents::TransactionRecord) {}
}

#[tokio::test]
async fn later_cancel_keeps_every_window_and_a_staged_draft_discard() {
    let host = TestHost::new(&["discard", "saved", "cancel"]);
    host.draft();
    assert!(!resolve(&host, "a", Trigger::Quit, vec![], &host.windows())
        .await
        .unwrap());
    assert!(host.closed.lock().unwrap().is_empty());
    assert!(!host.quit.load(Ordering::SeqCst));
    assert_eq!(
        host.registry.draft_info(&host.id()).unwrap().text,
        "local draft"
    );
    assert!(host.registry.snapshot(&host.id()).is_some());
}

#[tokio::test]
async fn quit_resolves_drafts_before_canonical_and_prompts_a_shared_document_once() {
    let host = TestHost::new(&["applied", "saved", "saved"]);
    let second = host.views["b"][1].clone();
    host.draft_for(&second);
    host.registry.save_to_disk(&second, None).unwrap();
    assert!(!host.registry.snapshot(&second).unwrap().dirty);
    assert!(resolve(&host, "a", Trigger::Quit, vec![], &host.windows())
        .await
        .unwrap());
    let events = host.events.lock().unwrap();
    let resolutions: Vec<_> = events
        .iter()
        .filter(|(_, action, _)| action.starts_with("resolve-"))
        .collect();
    assert_eq!(resolutions.len(), 3);
    assert_eq!(resolutions[0].1, "resolve-draft");
    assert_eq!(resolutions[0].0, "b");
    assert_ne!(resolutions[1].2, resolutions[2].2);
    assert_eq!(*host.closed.lock().unwrap(), vec!["a", "b"]);
    assert!(host.quit.load(Ordering::SeqCst));
}

#[tokio::test]
async fn failed_save_or_changed_window_set_never_starts_destruction() {
    let host = TestHost::new(&["saved"]);
    std::fs::remove_file(host.id()).unwrap();
    assert!(resolve(&host, "a", Trigger::Quit, vec![], &host.windows())
        .await
        .is_err());
    assert!(host.closed.lock().unwrap().is_empty());
    assert!(host.registry.snapshot(&host.id()).unwrap().dirty);
    let host = TestHost::new(&["discard", "discard"]);
    host.change_windows.store(true, Ordering::SeqCst);
    let participants = host.windows();
    assert!(resolve(&host, "a", Trigger::Quit, vec![], &participants)
        .await
        .is_err());
    assert!(host.closed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn late_revision_change_rejects_discard_without_closing_a_window() {
    let host = TestHost::new(&["change-before-discard", "discard"]);
    assert!(resolve(&host, "a", Trigger::Quit, vec![], &host.windows())
        .await
        .is_err());
    assert!(host.closed.lock().unwrap().is_empty());
    assert!(host
        .registry
        .snapshot(&host.id())
        .unwrap()
        .content
        .starts_with("remote"));
}

#[tokio::test]
async fn invalid_owner_apply_never_releases_the_lease_or_closes_any_window() {
    let host = TestHost::new(&["applied"]);
    host.draft();
    let lease = host.registry.draft_info(&host.id()).unwrap();
    host.registry
        .update_draft(
            &host.id(),
            "b",
            &lease.token,
            DraftUpdate {
                generation: 2,
                text: lease.text,
                valid: false,
            },
        )
        .unwrap();
    assert!(resolve(&host, "a", Trigger::Quit, vec![], &host.windows())
        .await
        .is_err());
    assert_eq!(
        host.registry.draft_info(&host.id()).unwrap().text,
        "local draft"
    );
    assert!(host.closed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn navigation_resolves_remote_draft_without_saving_or_losing_dirty_canonical_text() {
    for trigger in [Trigger::ModeSwitch, Trigger::TabSwitch] {
        let host = TestHost::new(&["discard"]);
        host.draft();
        assert!(
            resolve(&host, "a", trigger, vec![host.id()], &host.windows())
                .await
                .unwrap()
        );
        assert!(host.registry.draft_info(&host.id()).is_none());
        assert!(host.registry.snapshot(&host.id()).unwrap().dirty);
        assert!(host.closed.lock().unwrap().is_empty());
        assert!(!host
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|(_, action, _)| action == "resolve-canonical"));
    }
}

#[tokio::test]
async fn closing_one_shared_view_preserves_the_other_windows_dirty_document() {
    let host = TestHost::new(&[]);
    assert!(
        resolve(&host, "a", Trigger::CloseWindow, vec![], &host.windows())
            .await
            .unwrap()
    );
    assert_eq!(*host.closed.lock().unwrap(), vec!["a"]);
    assert!(host.registry.snapshot(&host.id()).unwrap().dirty);
    assert!(!host.quit.load(Ordering::SeqCst));
}

#[tokio::test]
async fn close_tab_releases_only_its_view_before_the_barrier_ends() {
    let host = TestHost::new(&[]);
    let id = host.id();
    assert!(resolve(
        &host,
        "a",
        Trigger::CloseTab,
        vec![id.clone()],
        &host.windows()
    )
    .await
    .unwrap());
    assert_eq!(host.registry.snapshot(&id).unwrap().content, "modified");
    assert_eq!(host.registry.release_view(&id).unwrap(), 0);
    assert!(host.closed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn reload_resolves_draft_then_replaces_under_the_freeze_and_remains_undoable() {
    let host = TestHost::new(&["discard", "discard"]);
    host.draft();
    assert!(resolve(
        &host,
        "a",
        Trigger::ReloadDocument,
        vec![host.id()],
        &host.windows()
    )
    .await
    .unwrap());
    assert_eq!(
        host.registry.snapshot(&host.id()).unwrap().content,
        "original"
    );
    assert!(host.registry.draft_info(&host.id()).is_none());
    assert!(host.closed.lock().unwrap().is_empty());
    host.registry.undo(&host.id()).unwrap();
    assert_eq!(
        host.registry.snapshot(&host.id()).unwrap().content,
        "modified"
    );
}
#[tokio::test]
async fn only_the_requested_window_can_acknowledge_and_destruction_fails_closed() {
    let lifecycle = Lifecycle::default();
    let (sender, receiver) = oneshot::channel();
    lifecycle.pending.lock().unwrap().insert(
        1,
        Pending {
            window: "owner".into(),
            reply: sender,
        },
    );
    assert!(lifecycle.reply("other", 1, Ok(json!("applied"))).is_err());
    lifecycle.window_destroyed("other");
    assert_eq!(lifecycle.pending.lock().unwrap().len(), 1);
    lifecycle.window_destroyed("owner");
    assert!(receiver.await.unwrap().is_err());
    assert!(lifecycle.reply("owner", 1, Ok(json!("applied"))).is_err());
}
