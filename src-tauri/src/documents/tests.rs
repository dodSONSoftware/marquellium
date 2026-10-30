//! M1 gate — document durability, conflict, round-trip, and Unicode-boundary
//! tests (PRD §11 M1, §10.2, docs/test-plan.md).
//!
//! These drive the real `DocumentRegistry` + `service` code (no GUI), so the
//! M1 "crash/conflict/round-trip tests pass before adding renderer features"
//! gate is enforced in CI.

use std::path::PathBuf;
use std::sync::Arc;

use crate::documents::registry::{DocumentRegistry, NewlinePolicy};
use crate::documents::service::{
    detect_newline, disk_revision, open_document, save_atomic, SaveError,
};
use crate::documents::DocOp;
use crate::documents::WireTransaction;

fn fixtures() -> PathBuf {
    // CARGO_MANIFEST_DIR = src-tauri; fixtures live at the repo root.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
        .join("fixtures")
}

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

// ---------------------------------------------------------------------------
// Byte-identical round-trip (FR-003, NFR-005)
// ---------------------------------------------------------------------------

#[test]
fn roundtrip_byte_identical_unmodified() {
    let rt = fixtures().join("markdown/roundtrip");
    let names = [
        "crlf.md",
        "bom.md",
        "bom-crlf.md",
        "no-trailing-newline.md",
        "mixed-endings.md",
        "trailing-spaces.md",
        "cr-only.md",
    ];
    for name in names {
        let src = rt.join(name);
        let original = std::fs::read(&src).unwrap();
        let dir = tmp();
        let dest = dir.path().join(name);
        std::fs::write(&dest, &original).unwrap();

        // Open (validates + detects), then save back with the expected
        // revision. Bytes must be identical.
        let (content, bom, _newline, rev) = open_document(&dest, false).unwrap();
        let bytes = with_bom(&content, bom);
        assert_eq!(bytes, original, "{name}: canonical bytes != original");
        assert_eq!(disk_revision(&dest).unwrap(), rev, "{name}: open revision");

        // Save unmodified content.
        let out = save_atomic(&dest, &bytes, Some(&rev)).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), original, "{name}: save changed bytes");
        assert_eq!(disk_revision(&dest).unwrap(), out, "{name}: post-save revision");
    }
}

fn with_bom(content: &str, bom: bool) -> Vec<u8> {
    let mut b = Vec::new();
    if bom {
        b.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    b.extend(content.bytes());
    b
}

// ---------------------------------------------------------------------------
// BOM + newline detection (ADR-010)
// ---------------------------------------------------------------------------

#[test]
fn bom_is_stripped_and_flagged() {
    let src = fixtures().join("markdown/roundtrip/bom.md");
    let (content, bom, _, _) = open_document(&src, false).unwrap();
    assert!(bom, "BOM should be detected");
    assert!(!content.starts_with('\u{feff}'), "BOM should be stripped from content");
    assert!(content.starts_with('#'), "content starts at real first char");
}

#[test]
fn newline_detection() {
    assert_eq!(detect_newline("a\r\nb\r\n"), NewlinePolicy::Crlf);
    assert_eq!(detect_newline("a\nb\n"), NewlinePolicy::Lf);
    assert_eq!(detect_newline("a\rb\r"), NewlinePolicy::Cr);
    assert_eq!(detect_newline("no break"), NewlinePolicy::None);
    // dominant wins (clear majority)
    assert_eq!(detect_newline("a\nb\r\nc\nd\ne\n"), NewlinePolicy::Lf);
    assert_eq!(detect_newline("a\rb\r\nc\r\nd\r\n"), NewlinePolicy::Crlf);
    // tie resolves to CRLF (documented behavior)
    assert_eq!(detect_newline("a\nb\r\nc\r\nd\n"), NewlinePolicy::Crlf);
}

// ---------------------------------------------------------------------------
// Conflict / stale save (T5, AT-108)
// ---------------------------------------------------------------------------

#[test]
fn stale_save_is_rejected_and_original_intact() {
    let dir = tmp();
    let p = dir.path().join("doc.md");
    std::fs::write(&p, "original\n").unwrap();
    let (content, bom, _, rev) = open_document(&p, false).unwrap();
    let bytes = with_bom(&content, bom);

    // An external editor changes the file after we opened it.
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(&p, "externally changed\n").unwrap();

    // Our save still carries the old expected revision => conflict.
    let res = save_atomic(&p, &bytes, Some(&rev));
    assert!(matches!(res, Err(SaveError::Conflict(_))), "expected conflict");
    // Original (external) content must be untouched.
    assert_eq!(std::fs::read_to_string(&p).unwrap(), "externally changed\n");
}

#[test]
fn save_with_matching_revision_succeeds() {
    let dir = tmp();
    let p = dir.path().join("doc.md");
    std::fs::write(&p, "one\n").unwrap();
    let (_content, bom, _, _) = open_document(&p, false).unwrap();
    // Simulate a new canonical buffer.
    let new_content = "one\ntwo\n";
    let mut bytes = Vec::new();
    if bom {
        bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    bytes.extend(new_content.bytes());
    let current = disk_revision(&p).unwrap();
    let out = save_atomic(&p, &bytes, Some(&current)).unwrap();
    assert_eq!(std::fs::read_to_string(&p).unwrap(), "one\ntwo\n");
    assert_eq!(disk_revision(&p).unwrap(), out);
}

#[test]
fn save_over_deleted_file_fails_closed() {
    let dir = tmp();
    let p = dir.path().join("doc.md");
    std::fs::write(&p, "x\n").unwrap();
    let (content, bom, _, _) = open_document(&p, false).unwrap();
    let bytes = with_bom(&content, bom);
    std::fs::remove_file(&p).unwrap();
    assert!(save_atomic(&p, &bytes, None).is_err(), "must not recreate");
    assert!(!p.exists());
}

// ---------------------------------------------------------------------------
// Encoding refusal / explicit conversion (T7, ADR-010)
// ---------------------------------------------------------------------------

#[test]
fn invalid_utf8_refused_without_conversion() {
    let src = fixtures().join("hostile-input/invalid-utf8.md");
    assert!(
        open_document(&src, false).is_err(),
        "invalid UTF-8 must be refused by default"
    );
}

#[test]
fn invalid_utf8_explicit_conversion_is_lossless_latin1() {
    let src = fixtures().join("hostile-input/invalid-utf8.md");
    let (content, bom, _, _) = open_document(&src, true).unwrap();
    assert!(!bom);
    // 0xE9 -> U+00E9 'é'
    assert!(content.contains('é'), "Latin-1 0xE9 should map to é");
    // Original file untouched.
    let raw = std::fs::read(&src).unwrap();
    assert!(raw.contains(&0xe9), "original bytes preserved");
}

// ---------------------------------------------------------------------------
// Registry: revision, ops, char-boundary, undo/redo, dirty (AT-103/116)
// ---------------------------------------------------------------------------

fn op(start: u32, end: u32, text: &str) -> DocOp {
    DocOp {
        start_byte: start,
        end_byte: end,
        text: text.to_string(),
    }
}

#[test]
fn apply_transaction_updates_content_and_revision() {
    let reg = DocumentRegistry::new();
    let id = reg.create_untitled();
    // seed content via an insert op at 0
    let rec = reg
        .apply_transaction(
            &id,
            &WireTransaction {
                base_revision: 0,
                ops: vec![op(0, 0, "hello")],
            },
        )
        .unwrap();
    assert_eq!(rec.revision, 1);
    let snap = reg.snapshot(&id).unwrap();
    assert_eq!(snap.content, "hello");
    assert_eq!(snap.revision, 1);
    assert!(snap.dirty, "untitled edits are dirty");
}

#[test]
fn stale_revision_is_rejected() {
    let reg = DocumentRegistry::new();
    let id = reg.create_untitled();
    let _ = reg
        .apply_transaction(
            &id,
            &WireTransaction {
                base_revision: 0,
                ops: vec![op(0, 0, "a")],
            },
        )
        .unwrap();
    // Now the doc is at revision 1; a transaction claiming base 0 must fail.
    let res = reg.apply_transaction(
        &id,
        &WireTransaction {
            base_revision: 0,
            ops: vec![op(1, 1, "b")],
        },
    );
    assert!(matches!(res, Err(crate::documents::ApplyError::StaleRevision { .. })));
    assert_eq!(reg.snapshot(&id).unwrap().content, "a", "failed tx must not mutate");
}

#[test]
fn op_splitting_a_char_boundary_is_rejected() {
    let reg = DocumentRegistry::new();
    let id = reg.create_untitled();
    let _ = reg
        .apply_transaction(
            &id,
            &WireTransaction {
                base_revision: 0,
                // "a" (1 byte) + "😀" (4 bytes) => offsets 1..5 are the emoji.
                ops: vec![op(0, 0, "a😀")],
            },
        )
        .unwrap();
    // start at byte 2 splits the 4-byte emoji (1,2,3,4 are inside it).
    let res = reg.apply_transaction(
        &id,
        &WireTransaction {
            base_revision: 1,
            ops: vec![op(2, 5, "x")],
        },
    );
    assert!(
        matches!(res, Err(crate::documents::ApplyError::InvalidOp(_))),
        "op splitting a UTF-8 char must be rejected"
    );
    // Content unchanged.
    assert_eq!(reg.snapshot(&id).unwrap().content, "a😀");
}

#[test]
fn overlapping_ops_are_rejected() {
    let reg = DocumentRegistry::new();
    let id = reg.create_untitled();
    let _ = reg
        .apply_transaction(
            &id,
            &WireTransaction {
                base_revision: 0,
                ops: vec![op(0, 0, "0123456789")],
            },
        )
        .unwrap();
    let res = reg.apply_transaction(
        &id,
        &WireTransaction {
            base_revision: 1,
            ops: vec![op(0, 3, "a"), op(2, 5, "b")], // overlap [2,3)
        },
    );
    assert!(matches!(res, Err(crate::documents::ApplyError::InvalidOp(_))));
}

#[test]
fn undo_redo_are_single_groups_and_shared() {
    let reg = DocumentRegistry::new();
    let id = reg.create_untitled();
    let base = |reg: &DocumentRegistry, id: &str| {
        reg.snapshot(id).unwrap().revision
    };

    // Edit 1: insert "ab"
    reg.apply_transaction(
        &id,
        &WireTransaction {
            base_revision: 0,
            ops: vec![op(0, 0, "ab")],
        },
    )
    .unwrap();
    // Edit 2: replace whole with "xyz"
    reg.apply_transaction(
        &id,
        &WireTransaction {
            base_revision: 1,
            ops: vec![op(0, 2, "xyz")],
        },
    )
    .unwrap();
    assert_eq!(reg.snapshot(&id).unwrap().content, "xyz");

    // One undo reverses exactly edit 2 (back to "ab"); the buffer revision
    // still advances (undo is itself a buffer change).
    let u = reg.undo(&id).unwrap().unwrap();
    assert_eq!(u.revision, 3, "undo event carries the new buffer revision");
    assert_eq!(base(&reg, &id), 3, "buffer revision bumped by the undo");
    assert_eq!(reg.snapshot(&id).unwrap().content, "ab");
    assert!(reg.can_redo(&id).unwrap());

    // Redo restores "xyz".
    reg.redo(&id).unwrap().unwrap();
    assert_eq!(reg.snapshot(&id).unwrap().content, "xyz");
    assert!(!reg.can_redo(&id).unwrap());
}

#[test]
fn undo_back_to_saved_state_clears_dirty() {
    let dir = tmp();
    let p = dir.path().join("doc.md");
    std::fs::write(&p, "start\n").unwrap();
    let (content, bom, newline, rev) = open_document(&p, false).unwrap();
    let reg = DocumentRegistry::new();
    let id = reg
        .insert_opened(&p, content, bom, newline, rev)
        .unwrap();
    assert!(!reg.is_dirty(&id).unwrap(), "fresh open is clean");

    // Edit then undo; content returns to the saved bytes => clean.
    reg.apply_transaction(
        &id,
        &WireTransaction {
            base_revision: 0,
            ops: vec![op(6, 6, "X")],
        },
    )
    .unwrap();
    assert!(reg.is_dirty(&id).unwrap());
    reg.undo(&id).unwrap().unwrap();
    assert!(!reg.is_dirty(&id).unwrap(), "undo to saved bytes clears dirty");
}

// ---------------------------------------------------------------------------
// Recovery snapshots (FR-006, NFR-004)
// ---------------------------------------------------------------------------

#[test]
fn recovery_snapshot_roundtrip_and_cleanup() {
    let dir = tmp();
    let store = crate::documents::recovery::RecoveryStore::new(dir.path());
    let key = "doc-1";
    let info = store
        .snapshot(key, None, b"unsaved content", 7, Some("draft".into()))
        .unwrap();
    assert!(info.has_draft);
    assert_eq!(info.revision, 7);

    let (bytes, meta) = store.read(key).unwrap();
    assert_eq!(bytes, b"unsaved content");
    assert_eq!(meta.revision, 7);
    assert_eq!(meta.draft.as_deref(), Some("draft"));

    let list = store.list();
    assert_eq!(list.len(), 1);

    store.remove(key);
    assert!(store.read(key).is_err());
    assert!(store.list().is_empty());
}

#[test]
fn recovery_snapshot_written_atomically_no_tear() {
    let dir = tmp();
    let store = crate::documents::recovery::RecoveryStore::new(dir.path());
    let big = vec![b'x'; 1_000_000];
    store.snapshot("big", None, &big, 1, None).unwrap();
    let (bytes, _) = store.read("big").unwrap();
    assert_eq!(bytes, big);
}

// ---------------------------------------------------------------------------
// Workspace path safety (T3, NFR-009, ADR-005)
// ---------------------------------------------------------------------------

#[test]
fn traversal_is_rejected() {
    let dir = tmp();
    let scope = dir.path().join("ws");
    std::fs::create_dir_all(&scope).unwrap();
    // in-scope resolves
    let inside = scope.join("a.md");
    std::fs::write(&inside, "x").unwrap();
    assert!(crate::workspace::resolve_in_scope(&scope, &PathBuf::from("a.md")).is_ok());
    // ../ escapes
    assert!(
        crate::workspace::resolve_in_scope(&scope, &PathBuf::from("../outside.md")).is_err()
    );
    assert!(crate::workspace::contains_traversal(&PathBuf::from("../x")));
}

#[test]
fn symlink_escape_is_rejected() {
    let dir = tmp();
    let scope = dir.path().join("ws");
    let outside = dir.path().join("secret");
    std::fs::create_dir_all(&scope).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("pass.txt"), "secret").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.join("pass.txt"), scope.join("link.txt")).unwrap();
    #[cfg(unix)]
    assert!(
        crate::workspace::resolve_in_scope(&scope, &PathBuf::from("link.txt")).is_err(),
        "symlink pointing outside scope must be rejected"
    );
}

// ---------------------------------------------------------------------------
// Concurrency: two "windows" (clients) on one document (AT-104/117)
// ---------------------------------------------------------------------------

#[test]
fn two_clients_cannot_diverge() {
    let reg = Arc::new(DocumentRegistry::new());
    let id = reg.create_untitled();
    let a = reg.clone();
    let b = reg.clone();

    // Client A applies a transaction (base 0).
    a.apply_transaction(
        &id,
        &WireTransaction {
            base_revision: 0,
            ops: vec![op(0, 0, "A")],
        },
    )
    .unwrap();

    // Client B still believes base is 0 => must be rejected (no split brain).
    let res = b.apply_transaction(
        &id,
        &WireTransaction {
            base_revision: 0,
            ops: vec![op(0, 0, "B")],
        },
    );
    assert!(matches!(res, Err(crate::documents::ApplyError::StaleRevision { .. })));
    assert_eq!(reg.snapshot(&id).unwrap().content, "A");
}

#[test]
fn same_path_is_one_entry_across_windows() {
    // FR-043/AT-117: two windows opening the same file must share one
    // canonical entry (find_by_path) and count views, never fork content.
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("shared.md");
    std::fs::write(&p, "hello\n").unwrap();

    let reg = DocumentRegistry::new();
    let (content, bom, newline, rev) = open_document(&p, false).unwrap();
    let id = reg.insert_opened(&p, content, bom, newline, rev).unwrap();
    assert_eq!(reg.find_by_path(&p).as_deref(), Some(id.as_str()));

    // Window B opens the same path: reuses the entry, no second one.
    assert_eq!(reg.get().len(), 1);
    reg.acquire_view(&id).unwrap();
    reg.acquire_view(&id).unwrap();
    reg.apply_transaction(
        &id,
        &WireTransaction {
            base_revision: 0,
            ops: vec![op(5, 5, " world")],
        },
    )
    .unwrap();
    // Window B sees window A's edit through the shared entry.
    assert_eq!(reg.snapshot(&id).unwrap().content, "hello world\n");
}

#[test]
fn releasing_one_view_keeps_canonical_state() {
    let reg = DocumentRegistry::new();
    let id = reg.create_untitled();
    reg.acquire_view(&id).unwrap();
    reg.acquire_view(&id).unwrap();
    reg.apply_transaction(
        &id,
        &WireTransaction {
            base_revision: 0,
            ops: vec![op(0, 0, "shared")],
        },
    )
    .unwrap();
    // One window closes.
    reg.release_view(&id).unwrap();
    // Data still alive and correct in the other.
    assert_eq!(reg.snapshot(&id).unwrap().content, "shared");
    assert!(reg.is_dirty(&id).unwrap());
}

#[test]
fn dispose_preserves_documents_with_surviving_views() {
    let reg = DocumentRegistry::new();
    let id = reg.create_untitled();
    reg.acquire_view(&id).unwrap();
    reg.acquire_view(&id).unwrap();
    reg.release_view(&id).unwrap();
    assert!(!reg.dispose(&id));
    assert!(reg.snapshot(&id).is_some());
    reg.release_view(&id).unwrap();
    assert!(reg.dispose(&id));
    assert!(reg.snapshot(&id).is_none());
}

#[test]
fn undo_redo_broadcasts_replay_exact_bytes_and_current_revisions() {
    use crate::documents::registry::wire_ops;
    let reg = DocumentRegistry::new();
    let id = reg.create_untitled();
    reg.apply_transaction(&id, &WireTransaction {
        base_revision: 0,
        ops: vec![DocOp { start_byte: 0, end_byte: 0, text: "a🎉bcdef".into() }],
    }).unwrap();
    let edit = reg.apply_transaction(&id, &WireTransaction {
        base_revision: 1,
        ops: vec![
            DocOp { start_byte: 0, end_byte: 1, text: "LONG".into() },
            DocOp { start_byte: 5, end_byte: 7, text: "X".into() },
        ],
    }).unwrap();
    let edited = reg.snapshot(&id).unwrap().content;
    let mut mirror = edited.clone();
    for expected_revision in 3..=8 {
        let record = if expected_revision % 2 == 1 {
            reg.undo(&id).unwrap().unwrap()
        } else {
            reg.redo(&id).unwrap().unwrap()
        };
        assert_eq!(record.revision, expected_revision);
        for op in wire_ops(&record).iter().rev() {
            mirror.replace_range(op.start_byte as usize..op.end_byte as usize, &op.text);
        }
        assert_eq!(mirror, reg.snapshot(&id).unwrap().content);
        assert_eq!(mirror, if expected_revision % 2 == 1 { "a🎉bcdef" } else { &edited });
    }
    assert_eq!(edit.revision, 2);
}
