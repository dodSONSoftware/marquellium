use super::*;
use crate::documents::{
    service::open_document, DocOp, DraftKind, DraftOpening, DraftUpdate, WireTransaction,
};
use serde_json::Value;

fn fixture() -> (
    tempfile::TempDir,
    PathBuf,
    DocumentRegistry,
    RecoveryStore,
    String,
    DraftLease,
) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("original.md");
    std::fs::write(&path, b"\xef\xbb\xbf# Original\r\n\r\nBody.").unwrap();
    let (text, bom, newline, revision) = open_document(&path, false).unwrap();
    let registry = DocumentRegistry::new();
    let id = registry
        .insert_opened(&path, text, bom, newline, revision)
        .unwrap();
    let lease = registry
        .acquire_draft(
            &id,
            "owner",
            DraftOpening {
                base_revision: 0,
                start_byte: 0,
                end_byte: 10,
                opening_text: "# Original".into(),
                kind: DraftKind::Source,
            },
        )
        .unwrap();
    let lease = registry
        .update_draft(
            &id,
            "owner",
            &lease.token,
            DraftUpdate {
                generation: 1,
                text: "# Changed".into(),
                valid: true,
            },
        )
        .unwrap();
    let recovery = RecoveryStore::new(dir.path().join("recovery"));
    (dir, path, registry, recovery, id, lease)
}

#[test]
fn modified_draft_over_clean_canonical_survives_restart_with_exact_metadata() {
    let (_dir, path, registry, recovery, id, _) = fixture();
    assert!(!registry.snapshot(&id).unwrap().dirty);
    let info = recovery.persist_document(&registry, &id).unwrap().unwrap();
    assert!(info.has_draft);
    let (bytes, meta) = recovery.read(&info.key).unwrap();
    assert_eq!(bytes, b"\xef\xbb\xbf# Original\r\n\r\nBody.");
    assert_eq!(meta.draft.as_deref(), Some("# Changed"));
    let reopened = RecoveryStore::new(recovery.base_dir.clone());
    let fresh = DocumentRegistry::new();
    let result = reopened.restore_document(&info.key, &fresh, true).unwrap();
    assert!(result.has_draft);
    assert!(!result.conflicted);
    let snapshot = fresh.snapshot(&result.doc_id).unwrap();
    assert!(snapshot.bom);
    assert_eq!(snapshot.newline, NewlinePolicy::Crlf);
    assert!(snapshot.path.is_none());
    assert_eq!(snapshot.content, "# Original\r\n\r\nBody.");
    let orphan = fresh.draft_info(&result.doc_id).unwrap();
    assert!(orphan.owner_window.is_none());
    assert_eq!(orphan.opening.base_revision, snapshot.revision);
    let owned = fresh
        .resume_draft(&result.doc_id, "new-owner", &orphan.token)
        .unwrap();
    assert_ne!(owned.token, orphan.token);
    fresh
        .update_draft(
            &result.doc_id,
            "new-owner",
            &owned.token,
            DraftUpdate {
                generation: 2,
                text: "# Changed".into(),
                valid: true,
            },
        )
        .unwrap();
    fresh
        .apply_draft(
            &result.doc_id,
            "new-owner",
            &owned.token,
            2,
            vec![DocOp {
                start_byte: 0,
                end_byte: 10,
                text: "# Changed".into(),
            }],
        )
        .unwrap();
    assert_eq!(
        fresh.snapshot(&result.doc_id).unwrap().content,
        "# Changed\r\n\r\nBody."
    );
    assert_eq!(
        std::fs::read(path).unwrap(),
        b"\xef\xbb\xbf# Original\r\n\r\nBody."
    );
}

#[test]
fn changed_disk_and_stale_canonical_bases_restore_separate_draft_copies() {
    for disk_changed in [false, true] {
        let (_dir, path, registry, recovery, id, _) = fixture();
        if !disk_changed {
            registry
                .apply_transaction(
                    &id,
                    &WireTransaction {
                        base_revision: 0,
                        ops: vec![DocOp {
                            start_byte: 0,
                            end_byte: 0,
                            text: "prefix\n\n".into(),
                        }],
                    },
                )
                .unwrap();
        }
        let info = recovery.persist_document(&registry, &id).unwrap().unwrap();
        if disk_changed {
            std::fs::write(&path, "disk changed").unwrap();
        }
        let before = std::fs::read(&path).unwrap();
        let fresh = DocumentRegistry::new();
        let restored = recovery.restore_document(&info.key, &fresh, true).unwrap();
        assert!(restored.conflicted);
        assert!(!restored.has_draft);
        assert!(fresh.draft_info(&restored.doc_id).is_none());
        let new_key = recovery.document_key(&None, &restored.doc_id);
        assert!(
            recovery
                .read(&new_key)
                .unwrap()
                .1
                .context
                .unwrap()
                .conflicted
        );
        assert_eq!(
            fresh
                .snapshot(&restored.draft_copy_id.unwrap())
                .unwrap()
                .content,
            "# Changed"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}

#[test]
fn missing_original_restores_safe_copies_without_recreating_the_disk_file() {
    let (_dir, path, registry, recovery, id, _) = fixture();
    let info = recovery.persist_document(&registry, &id).unwrap().unwrap();
    std::fs::remove_file(&path).unwrap();
    let fresh = DocumentRegistry::new();
    let restored = recovery.restore_document(&info.key, &fresh, true).unwrap();
    assert!(restored.conflicted);
    assert!(!restored.has_draft);
    assert!(fresh.draft_info(&restored.doc_id).is_none());
    let canonical = fresh.snapshot(&restored.doc_id).unwrap();
    assert!(canonical.path.is_none());
    assert_eq!(canonical.content, "# Original\r\n\r\nBody.");
    assert!(canonical.bom);
    let draft = fresh.snapshot(&restored.draft_copy_id.unwrap()).unwrap();
    assert!(draft.path.is_none());
    assert_eq!(draft.content, "# Changed");
    assert!(!path.exists());
}

#[test]
fn canonical_save_retains_unapplied_draft_and_cancel_removes_only_resolved_recovery() {
    let (_dir, path, registry, recovery, id, lease) = fixture();
    recovery.persist_document(&registry, &id).unwrap();
    registry.save_to_disk(&id, None).unwrap();
    let info = recovery.persist_document(&registry, &id).unwrap().unwrap();
    assert!(info.has_draft);
    assert!(!registry.snapshot(&id).unwrap().dirty);
    assert!(!std::fs::read_to_string(path).unwrap().contains("Changed"));
    registry.release_draft(&id, "owner", &lease.token).unwrap();
    assert!(recovery.persist_document(&registry, &id).unwrap().is_none());
    assert!(recovery.persist_document(&registry, &id).unwrap().is_none());
    assert!(recovery.list().is_empty());
}

#[test]
fn recovery_without_visual_capability_preserves_draft_in_a_source_copy() {
    let (_dir, _, registry, recovery, id, _) = fixture();
    let info = recovery.persist_document(&registry, &id).unwrap().unwrap();
    let fresh = DocumentRegistry::new();
    let result = recovery.restore_document(&info.key, &fresh, false).unwrap();
    assert!(!result.has_draft);
    assert_eq!(
        fresh
            .snapshot(&result.draft_copy_id.unwrap())
            .unwrap()
            .content,
        "# Changed"
    );
    assert!(fresh.draft_info(&result.doc_id).is_none());
}

#[test]
fn torn_temporary_records_are_ignored_and_keys_cannot_escape_the_store() {
    let (_dir, _, registry, recovery, id, _) = fixture();
    let info = recovery.persist_document(&registry, &id).unwrap().unwrap();
    std::fs::write(
        recovery.base_dir.join(format!("{}.tmp", info.key)),
        b"partial",
    )
    .unwrap();
    assert_eq!(recovery.list().len(), 1);
    assert!(recovery.read("../outside").is_err());
    let file = recovery.base_dir.join(format!("{}.record.json", info.key));
    let mut record: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    record["bytes"] = serde_json::json!([1, 2, 3]);
    std::fs::write(file, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(recovery.read(&info.key).is_err());
    assert!(recovery.list().is_empty());
}

#[test]
fn legacy_snapshots_remain_readable_but_unbound_drafts_never_attach_to_ranges() {
    let dir = tempfile::tempdir().unwrap();
    let recovery = RecoveryStore::new(dir.path());
    std::fs::write(dir.path().join("legacy.snap"), b"canonical").unwrap();
    std::fs::write(
        dir.path().join("legacy.meta.json"),
        br#"{"path":null,"createdAt":1,"created_at":1,"revision":2,"draft":"unbound draft"}"#,
    )
    .unwrap();
    let registry = DocumentRegistry::new();
    let restored = recovery
        .restore_document("legacy", &registry, true)
        .unwrap();
    assert!(!restored.has_draft);
    assert!(restored.conflicted);
    assert_eq!(
        registry
            .snapshot(&restored.draft_copy_id.unwrap())
            .unwrap()
            .content,
        "unbound draft"
    );
}

#[test]
fn live_session_records_are_not_offered_as_crash_recovery_in_a_second_window() {
    let (_dir, _, registry, recovery, id, _) = fixture();
    recovery.persist_document(&registry, &id).unwrap();
    assert!(recovery.list_for_restore().is_empty());
    let restarted = RecoveryStore::new(recovery.base_dir.clone());
    assert_eq!(restarted.list_for_restore().len(), 1);
}

#[test]
fn new_session_save_and_timer_cannot_overwrite_deferred_crash_recovery() {
    let (_dir, path, registry, recovery, id, _) = fixture();
    let old = recovery.persist_document(&registry, &id).unwrap().unwrap();
    let restarted = RecoveryStore::new(recovery.base_dir.clone());
    let fresh = DocumentRegistry::new();
    let (text, bom, newline, revision) = open_document(&path, false).unwrap();
    let fresh_id = fresh
        .insert_opened(&path, text, bom, newline, revision)
        .unwrap();
    fresh.save_to_disk(&fresh_id, None).unwrap();
    assert!(restarted
        .persist_document(&fresh, &fresh_id)
        .unwrap()
        .is_none());
    fresh
        .apply_transaction(
            &fresh_id,
            &WireTransaction {
                base_revision: 0,
                ops: vec![DocOp {
                    start_byte: 0,
                    end_byte: 0,
                    text: "new work\n".into(),
                }],
            },
        )
        .unwrap();
    let current = restarted
        .persist_document(&fresh, &fresh_id)
        .unwrap()
        .unwrap();
    assert_ne!(old.key, current.key);
    assert_eq!(
        restarted.read(&old.key).unwrap().1.draft.as_deref(),
        Some("# Changed")
    );
    assert_eq!(restarted.list_for_restore().len(), 1);
}

#[test]
fn failed_post_apply_maintenance_leaves_the_acknowledged_pre_apply_draft_recoverable() {
    let (_dir, path, registry, recovery, id, lease) = fixture();
    let old = recovery.persist_document(&registry, &id).unwrap().unwrap();
    registry
        .apply_draft(
            &id,
            "owner",
            &lease.token,
            lease.generation,
            vec![DocOp {
                start_byte: 0,
                end_byte: 10,
                text: "# Changed".into(),
            }],
        )
        .unwrap();
    std::fs::create_dir(recovery.base_dir.join(format!("{}.tmp", old.key))).unwrap();
    assert!(recovery.persist_document(&registry, &id).is_err());
    assert_eq!(
        registry.snapshot(&id).unwrap().content,
        "# Changed\r\n\r\nBody."
    );
    assert_eq!(
        recovery.read(&old.key).unwrap().1.draft.as_deref(),
        Some("# Changed")
    );
    let restarted = RecoveryStore::new(recovery.base_dir.clone());
    let fresh = DocumentRegistry::new();
    let restored = restarted.restore_document(&old.key, &fresh, true).unwrap();
    assert!(restored.has_draft);
    assert_eq!(
        fresh.draft_info(&restored.doc_id).unwrap().text,
        "# Changed"
    );
    assert_eq!(
        std::fs::read(path).unwrap(),
        b"\xef\xbb\xbf# Original\r\n\r\nBody."
    );
}

#[test]
fn invalid_math_draft_recovers_with_kind_and_exact_source_without_changing_disk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("math.md");
    let original = "$$\r\nx^2\r\n$$";
    std::fs::write(&path, original).unwrap();
    let (text, bom, newline, revision) = open_document(&path, false).unwrap();
    let registry = DocumentRegistry::new();
    let id = registry
        .insert_opened(&path, text, bom, newline, revision)
        .unwrap();
    let lease = registry
        .acquire_draft(
            &id,
            "owner",
            DraftOpening {
                base_revision: 0,
                start_byte: 0,
                end_byte: original.len() as u32,
                opening_text: original.into(),
                kind: DraftKind::Math,
            },
        )
        .unwrap();
    let invalid = "$$\r\n\\frac{\r\n$$";
    registry
        .update_draft(
            &id,
            "owner",
            &lease.token,
            DraftUpdate {
                generation: 1,
                text: invalid.into(),
                valid: false,
            },
        )
        .unwrap();
    let recovery = RecoveryStore::new(dir.path().join("recovery"));
    let info = recovery.persist_document(&registry, &id).unwrap().unwrap();
    let restarted = RecoveryStore::new(dir.path().join("recovery"));
    let restored_registry = DocumentRegistry::new();
    let restored = restarted
        .restore_document(&info.key, &restored_registry, true)
        .unwrap();
    let draft = restored_registry.draft_info(&restored.doc_id).unwrap();
    assert_eq!(draft.opening.kind, DraftKind::Math);
    assert_eq!(draft.text, invalid);
    assert_eq!(draft.owner_window, None);
    assert!(!draft.valid);
    assert_eq!(std::fs::read_to_string(path).unwrap(), original);
}
