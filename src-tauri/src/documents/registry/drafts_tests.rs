use super::*;
use crate::documents::{DraftKind, DraftOpening, DraftUpdate, WireTransaction};
use std::sync::{Arc, Barrier};

fn fixture() -> (DocumentRegistry, String, tempfile::TempDir, DraftOpening) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("draft.md");
    let text = "Before\n\n| a | b |\n|---|---|\n| 🎉 | 2 |\n\nAfter";
    std::fs::write(&path, text).unwrap();
    let reg = DocumentRegistry::new();
    let (content, bom, newline, revision) =
        crate::documents::service::open_document(&path, false).unwrap();
    let id = reg
        .insert_opened(&path, content, bom, newline, revision)
        .unwrap();
    let start = text.find('|').unwrap();
    let end = text.find("\n\nAfter").unwrap();
    let opening = DraftOpening {
        base_revision: 0,
        start_byte: start as u32,
        end_byte: end as u32,
        opening_text: text[start..end].into(),
        kind: DraftKind::Table,
    };
    (reg, id, dir, opening)
}
fn acknowledge(reg: &DocumentRegistry, id: &str, token: &str, opening: &DraftOpening) {
    reg.update_draft(
        id,
        "a",
        token,
        DraftUpdate {
            generation: 1,
            text: opening.opening_text.replace('2', "3"),
            valid: true,
        },
    )
    .unwrap();
}
fn edit(opening: &DraftOpening) -> Vec<DocOp> {
    let start = opening.start_byte + opening.opening_text.find('2').unwrap() as u32;
    vec![DocOp {
        start_byte: start,
        end_byte: start + 1,
        text: "3".into(),
    }]
}
fn canonical(reg: &DocumentRegistry, id: &str) -> serde_json::Value {
    let mut snapshot = serde_json::to_value(reg.snapshot(id).unwrap()).unwrap();
    snapshot.as_object_mut().unwrap().remove("draftActive");
    snapshot
}

#[test]
fn draft_updates_do_not_mutate_canonical_dirty_metadata_history_or_disk() {
    let (reg, id, dir, opening) = fixture();
    let before = canonical(&reg, &id);
    let lease = reg.acquire_draft(&id, "a", opening.clone()).unwrap();
    acknowledge(&reg, &id, &lease.token, &opening);
    assert_eq!(canonical(&reg, &id), before);
    assert!(!reg.can_undo(&id).unwrap());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("draft.md")).unwrap(),
        reg.snapshot(&id).unwrap().content
    );
    reg.release_draft(&id, "a", &lease.token).unwrap();
    assert_eq!(canonical(&reg, &id), before);
}

#[test]
fn simultaneous_acquisitions_have_one_winner() {
    let (reg, id, _dir, opening) = fixture();
    let reg = Arc::new(reg);
    let barrier = Arc::new(Barrier::new(2));
    let threads: Vec<_> = ["a", "b"]
        .into_iter()
        .map(|owner| {
            let (reg, barrier, id, opening) =
                (reg.clone(), barrier.clone(), id.clone(), opening.clone());
            std::thread::spawn(move || {
                barrier.wait();
                reg.acquire_draft(&id, owner, opening).is_ok()
            })
        })
        .collect();
    assert_eq!(
        threads
            .into_iter()
            .map(|thread| thread.join().expect("acquisition thread panicked"))
            .filter(|won| *won)
            .count(),
        1
    );
}

#[test]
fn wrong_owner_token_and_old_generation_cannot_mutate_or_release_a_lease() {
    let (reg, id, _dir, opening) = fixture();
    let lease = reg.acquire_draft(&id, "a", opening.clone()).unwrap();
    acknowledge(&reg, &id, &lease.token, &opening);
    for (owner, token) in [("b", lease.token.as_str()), ("a", "wrong")] {
        assert!(reg.release_draft(&id, owner, token).is_err());
        assert!(reg
            .update_draft(
                &id,
                owner,
                token,
                DraftUpdate {
                    generation: 2,
                    text: "bad".into(),
                    valid: true
                }
            )
            .is_err());
        assert!(reg
            .apply_draft(&id, owner, token, 1, edit(&opening))
            .is_err());
    }
    assert!(reg
        .update_draft(
            &id,
            "a",
            &lease.token,
            DraftUpdate {
                generation: 0,
                text: opening.opening_text.clone(),
                valid: true
            }
        )
        .is_err());
    assert!(reg
        .update_draft(
            &id,
            "a",
            &lease.token,
            DraftUpdate {
                generation: 1,
                text: "different".into(),
                valid: true
            }
        )
        .is_err());
    assert!(reg
        .apply_draft(&id, "a", &lease.token, 0, edit(&opening))
        .is_err());
    assert_eq!(
        reg.draft_info(&id).unwrap().text,
        opening.opening_text.replace('2', "3")
    );
    reg.release_draft(&id, "a", &lease.token).unwrap();
    let next = reg.acquire_draft(&id, "a", opening).unwrap();
    assert_ne!(next.token, lease.token);
    assert!(reg.release_draft(&id, "a", &lease.token).is_err());
}

#[test]
fn invalid_opening_ranges_and_stale_bases_do_not_acquire() {
    let (reg, id, _dir, opening) = fixture();
    let mut bad = opening.clone();
    bad.base_revision = 1;
    assert!(reg.acquire_draft(&id, "a", bad).is_err());
    let mut bad = opening.clone();
    bad.opening_text = "wrong".into();
    assert!(reg.acquire_draft(&id, "a", bad).is_err());
    let mut bad = opening.clone();
    bad.start_byte = bad.end_byte + 1;
    assert!(reg.acquire_draft(&id, "a", bad).is_err());
    let mut bad = opening.clone();
    bad.start_byte += bad.opening_text.find('🎉').unwrap() as u32 + 1;
    assert!(reg.acquire_draft(&id, "a", bad).is_err());
    assert!(reg.draft_info(&id).is_none());
}

#[test]
fn failed_apply_is_atomic_and_retains_draft() {
    let (reg, id, _dir, opening) = fixture();
    let lease = reg.acquire_draft(&id, "a", opening.clone()).unwrap();
    let before = canonical(&reg, &id);
    assert!(reg.apply_draft(&id, "a", &lease.token, 0, vec![]).is_err());
    acknowledge(&reg, &id, &lease.token, &opening);
    let emoji = opening.start_byte + opening.opening_text.find('🎉').unwrap() as u32;
    let failures = vec![
        vec![],
        vec![DocOp {
            start_byte: 0,
            end_byte: 1,
            text: "Z".into(),
        }],
        vec![DocOp {
            start_byte: emoji + 1,
            end_byte: emoji + 2,
            text: "Z".into(),
        }],
        vec![DocOp {
            text: "4".into(),
            ..edit(&opening)[0].clone()
        }],
    ];
    for ops in failures {
        assert!(reg.apply_draft(&id, "a", &lease.token, 1, ops).is_err());
        assert_eq!(canonical(&reg, &id), before);
        assert_eq!(reg.draft_info(&id).unwrap().token, lease.token);
        assert!(!reg.can_undo(&id).unwrap());
    }
}

#[test]
fn apply_commits_and_releases_as_one_undo_group() {
    let (reg, id, _dir, opening) = fixture();
    let before = reg.snapshot(&id).unwrap().content;
    let lease = reg.acquire_draft(&id, "a", opening.clone()).unwrap();
    acknowledge(&reg, &id, &lease.token, &opening);
    let record = reg
        .apply_draft(&id, "a", &lease.token, 1, edit(&opening))
        .unwrap()
        .unwrap();
    assert_eq!(record.revision, 1);
    assert_eq!(record.ops.len(), 1);
    assert!(reg.draft_info(&id).is_none());
    assert!(reg.snapshot(&id).unwrap().dirty);
    assert_eq!(reg.snapshot(&id).unwrap().content, before.replace('2', "3"));
    reg.undo(&id).unwrap();
    assert_eq!(reg.snapshot(&id).unwrap().content, before);
    assert!(!reg.snapshot(&id).unwrap().dirty);
    assert!(!reg.can_undo(&id).unwrap());
    reg.redo(&id).unwrap();
    assert!(reg.draft_info(&id).is_none());
    assert_eq!(reg.snapshot(&id).unwrap().content, before.replace('2', "3"));
}

#[test]
fn unchanged_apply_releases_without_history_revision_or_dirty_change() {
    let (reg, id, _dir, opening) = fixture();
    let before = canonical(&reg, &id);
    let lease = reg.acquire_draft(&id, "a", opening.clone()).unwrap();
    reg.update_draft(
        &id,
        "a",
        &lease.token,
        DraftUpdate {
            generation: 0,
            text: opening.opening_text,
            valid: true,
        },
    )
    .unwrap();
    assert!(reg
        .apply_draft(&id, "a", &lease.token, 0, vec![])
        .unwrap()
        .is_none());
    assert!(reg.draft_info(&id).is_none());
    assert_eq!(canonical(&reg, &id), before);
    assert!(!reg.can_undo(&id).unwrap());
}

#[test]
fn active_table_draft_blocks_direct_localized_edits_but_source_changes_make_it_stale() {
    let (reg, id, _dir, opening) = fixture();
    let lease = reg.acquire_draft(&id, "a", opening.clone()).unwrap();
    acknowledge(&reg, &id, &lease.token, &opening);
    let transaction = WireTransaction {
        base_revision: 0,
        ops: edit(&opening),
    };
    assert!(matches!(
        reg.apply_localized_transaction(&id, &transaction),
        Err(crate::documents::ApplyError::ActiveDraft)
    ));
    reg.apply_transaction(&id, &transaction).unwrap();
    assert!(reg
        .apply_draft(&id, "a", &lease.token, 1, edit(&opening))
        .unwrap_err()
        .contains("stale"));
    assert_eq!(
        reg.draft_info(&id).unwrap().text,
        opening.opening_text.replace('2', "3")
    );
    reg.release_draft(&id, "a", &lease.token).unwrap();
}

#[test]
fn nonoverlapping_localized_edits_can_commit_but_invalidate_the_draft_base() {
    let (reg, id, _dir, opening) = fixture();
    let lease = reg.acquire_draft(&id, "a", opening.clone()).unwrap();
    acknowledge(&reg, &id, &lease.token, &opening);
    let tx = WireTransaction {
        base_revision: 0,
        ops: vec![DocOp {
            start_byte: 0,
            end_byte: 1,
            text: "X".into(),
        }],
    };
    reg.apply_localized_transaction(&id, &tx).unwrap();
    assert!(reg
        .apply_draft(&id, "a", &lease.token, 1, edit(&opening))
        .is_err());
    assert!(reg
        .apply_localized_transaction(
            &id,
            &WireTransaction {
                base_revision: 1,
                ops: tx.ops
            }
        )
        .is_err());
    assert!(reg.draft_info(&id).is_some());
}

#[test]
fn owner_destruction_preserves_modified_drafts_and_rotates_tokens_on_resume() {
    let (reg, id, _dir, opening) = fixture();
    let clean = reg.acquire_draft(&id, "a", opening.clone()).unwrap();
    reg.detach_window_drafts("a");
    assert!(reg.draft_info(&id).is_none());
    let lease = reg.acquire_draft(&id, "a", opening.clone()).unwrap();
    acknowledge(&reg, &id, &lease.token, &opening);
    reg.detach_window_drafts("a");
    let orphan = reg.draft_info(&id).unwrap();
    assert!(orphan.owner_window.is_none());
    assert!(!orphan.valid);
    assert!(!reg.dispose(&id));
    assert!(reg
        .update_draft(
            &id,
            "a",
            &lease.token,
            DraftUpdate {
                generation: 2,
                text: "bad".into(),
                valid: true
            }
        )
        .is_err());
    let resumed = reg.resume_draft(&id, "b", &orphan.token).unwrap();
    assert_ne!(resumed.token, lease.token);
    assert_ne!(resumed.token, clean.token);
    assert_eq!(resumed.text, opening.opening_text.replace('2', "3"));
    assert!(reg.release_draft(&id, "a", &lease.token).is_err());
    reg.update_draft(
        &id,
        "b",
        &resumed.token,
        DraftUpdate {
            generation: 1,
            text: resumed.text,
            valid: true,
        },
    )
    .unwrap();
    assert!(reg
        .apply_draft(&id, "b", &resumed.token, 1, edit(&opening))
        .unwrap()
        .is_some());
}

#[test]
fn resuming_a_stale_orphan_never_overwrites_new_canonical_content() {
    let (reg, id, _dir, opening) = fixture();
    let lease = reg.acquire_draft(&id, "a", opening.clone()).unwrap();
    acknowledge(&reg, &id, &lease.token, &opening);
    reg.detach_window_drafts("a");
    reg.apply_transaction(
        &id,
        &WireTransaction {
            base_revision: 0,
            ops: vec![DocOp {
                start_byte: 0,
                end_byte: 1,
                text: "X".into(),
            }],
        },
    )
    .unwrap();
    let resumed = reg.resume_draft(&id, "b", &lease.token).unwrap();
    reg.update_draft(
        &id,
        "b",
        &resumed.token,
        DraftUpdate {
            generation: 1,
            text: resumed.text,
            valid: true,
        },
    )
    .unwrap();
    let before = canonical(&reg, &id);
    assert!(reg
        .apply_draft(&id, "b", &resumed.token, 1, edit(&opening))
        .unwrap_err()
        .contains("stale"));
    assert_eq!(canonical(&reg, &id), before);
    assert!(reg.draft_info(&id).is_some());
}

#[test]
fn multi_op_draft_apply_uses_prebatch_offsets_and_one_history_entry() {
    let (reg, id, _dir, opening) = fixture();
    let before = reg.snapshot(&id).unwrap().content;
    let lease = reg.acquire_draft(&id, "a", opening.clone()).unwrap();
    let text = opening
        .opening_text
        .replace("| a |", "| alpha |")
        .replace('2', "3");
    reg.update_draft(
        &id,
        "a",
        &lease.token,
        DraftUpdate {
            generation: 1,
            text: text.clone(),
            valid: true,
        },
    )
    .unwrap();
    let header = opening.start_byte + 2;
    let mut ops = vec![DocOp {
        start_byte: header,
        end_byte: header + 1,
        text: "alpha".into(),
    }];
    ops.extend(edit(&opening));
    let record = reg
        .apply_draft(&id, "a", &lease.token, 1, ops)
        .unwrap()
        .unwrap();
    assert_eq!(record.ops.len(), 2);
    assert_eq!(
        reg.snapshot(&id).unwrap().content,
        before.replace(&opening.opening_text, &text)
    );
    reg.undo(&id).unwrap();
    assert_eq!(reg.snapshot(&id).unwrap().content, before);
    assert!(!reg.can_undo(&id).unwrap());
}

#[test]
fn source_edit_racing_draft_apply_has_one_atomic_winner() {
    let (reg, id, _dir, opening) = fixture();
    let lease = reg.acquire_draft(&id, "a", opening.clone()).unwrap();
    acknowledge(&reg, &id, &lease.token, &opening);
    let reg = Arc::new(reg);
    let barrier = Arc::new(Barrier::new(2));
    let (a_reg, a_barrier, a_id, a_opening) =
        (reg.clone(), barrier.clone(), id.clone(), opening.clone());
    let draft = std::thread::spawn(move || {
        a_barrier.wait();
        a_reg
            .apply_draft(&a_id, "a", &lease.token, 1, edit(&a_opening))
            .is_ok()
    });
    let (b_reg, b_barrier, b_id) = (reg.clone(), barrier.clone(), id.clone());
    let source = std::thread::spawn(move || {
        b_barrier.wait();
        let mut ops = edit(&opening);
        ops[0].text = "4".into();
        b_reg
            .apply_transaction(
                &b_id,
                &WireTransaction {
                    base_revision: 0,
                    ops,
                },
            )
            .is_ok()
    });
    let draft_won = draft.join().expect("draft thread panicked");
    let source_won = source.join().expect("source thread panicked");
    assert_ne!(draft_won, source_won);
    assert_eq!(reg.snapshot(&id).unwrap().revision, 1);
    assert_eq!(reg.draft_info(&id).is_none(), draft_won);
    reg.undo(&id).unwrap();
    assert!(!reg.can_undo(&id).unwrap());
}
