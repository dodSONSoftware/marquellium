//! The shared in-process document registry (ADR-006).
//!
//! One entry per canonical document (path or untitled id). The entry is the
//! single source of truth for content, revision, undo/redo, dirty state, and
//! the inline-draft flag. Every mutation goes through
//! [`DocumentRegistry::apply_transaction`], which validates the base revision
//! and UTF-8 char boundaries before touching anything (fail closed, ADR-010).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use crate::documents::service::{DiskRevision, DocumentSnapshot};
use crate::documents::{DocOp, WireTransaction};

/// Canonical document identifier: the path string for saved documents,
/// `untitled-<n>` for new documents.
pub type DocId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NewlinePolicy {
    /// Dominant ending was LF.
    Lf,
    /// Dominant ending was CRLF.
    Crlf,
    /// Dominant ending was a bare CR (classic Mac).
    Cr,
    /// No line breaks observed (or empty document): new lines use LF.
    None,
}

/// One applied op, including the captured pre-image needed to invert it
/// (ADR-007: inverses are exact because old text is captured at apply time).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedOp {
    pub start_byte: u32,
    pub end_byte: u32,
    pub text: String,
    #[serde(skip_serializing)]
    pub(crate) old_text: String,
}

/// A committed transaction (one undo group).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionRecord {
    /// Revision the buffer moved TO.
    pub revision: u64,
    pub ops: Vec<AppliedOp>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum OpValidationError {
    #[error("byte offset {0} is not a UTF-8 char boundary")]
    NotCharBoundary(u32),
    #[error("end byte {end_byte} exceeds content length {len}")]
    OutOfBounds { end_byte: u32, len: usize },
    #[error("end byte {end} is before start byte {start}")]
    Inverted { start: u32, end: u32 },
    #[error("ops must be in ascending order (op {0})")]
    OutOfOrder(usize),
    #[error("ops must not overlap (op {0})")]
    Overlapping(usize),
}

/// One canonical document.
pub struct DocEntry {
    pub path: Option<PathBuf>,
    /// Canonical UTF-8 content, BOM stripped (the BOM is tracked separately).
    pub content: String,
    pub bom: bool,
    /// Dominant line ending at open time; used only to choose the ending for
    /// newly introduced line breaks (ADR-010).
    pub newline: NewlinePolicy,
    /// Monotonic buffer version. Bumped by every change including undo/redo.
    pub revision: u64,
    /// Disk revision at last successful save.
    pub saved_revision: Option<DiskRevision>,
    /// Last observed disk revision (watcher or save).
    pub disk_revision: Option<DiskRevision>,
    pub dirty: bool,
    /// How many window views currently show this document (AT-117).
    pub views: u32,
    /// Set while an inline source draft session is open (ADR-008).
    pub draft_active: Option<String>,
    undo: Vec<TransactionRecord>,
    redo: Vec<TransactionRecord>,
}

impl DocEntry {
    /// Dirty state. Flag-based; recomputed from bytes on undo/redo so that
    /// undoing back to the saved state clears the dirty flag (FR-044).
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// Recompute the flag by comparing canonical bytes to the last saved
    /// revision. Only called on undo/redo (rare), never on read paths.
    pub fn recompute_dirty(&mut self) {
        if self.path.is_none() || self.saved_revision.is_none() {
            self.dirty = true;
            return;
        }
        let cur = crate::documents::service::disk_revision_bytes(&self.file_bytes());
        let saved = self.saved_revision.as_ref().unwrap();
        self.dirty = cur.content_hash != saved.content_hash || cur.size_bytes != saved.size_bytes;
    }

    pub fn file_bytes(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(3 + self.content.len());
        if self.bom {
            b.extend_from_slice(&[0xef, 0xbb, 0xbf]);
        }
        b.extend_from_slice(self.content.as_bytes());
        b
    }
}

/// Payload broadcast to all windows after a canonical change.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentUpdate {
    pub doc_id: DocId,
    pub revision: u64,
    /// The ops just applied (so other windows' mirrors can replay them).
    pub ops: Vec<DocOp>,
    pub dirty: bool,
    /// `"edit" | "undo" | "redo"` — informational; mirrors apply `ops` either
    /// way.
    pub kind: String,
}

struct Inner {
    docs: HashMap<DocId, DocEntry>,
    untitled_counter: u64,
}

pub struct DocumentRegistry {
    inner: Mutex<Inner>,
}

impl Default for DocumentRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl DocumentRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                docs: HashMap::new(),
                untitled_counter: 0,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().expect("document registry poisoned")
    }

    /// Create a new untitled document.
    pub fn create_untitled(&self) -> DocId {
        let mut inner = self.lock();
        inner.untitled_counter += 1;
        let id = format!("untitled-{}", inner.untitled_counter);
        let entry = DocEntry {
            path: None,
            content: String::new(),
            bom: false,
            newline: NewlinePolicy::None,
            revision: 0,
            saved_revision: None,
            disk_revision: None,
            dirty: true,
            views: 0,
            draft_active: None,
            undo: Vec::new(),
            redo: Vec::new(),
        };
        inner.docs.insert(id.clone(), entry);
        id
    }

    /// Register a document that was read from disk (by `service::open`).
    pub fn insert_opened(
        &self,
        path: &Path,
        content: String,
        bom: bool,
        newline: NewlinePolicy,
        disk_revision: DiskRevision,
    ) -> Result<DocId, String> {
        let mut inner = self.lock();
        let id = path.to_string_lossy().into_owned();
        if inner.docs.contains_key(&id) {
            return Err(format!("document already open: {id}"));
        }
        inner.docs.insert(
            id.clone(),
            DocEntry {
                path: Some(path.to_path_buf()),
                content,
                bom,
                newline,
                revision: 0,
                saved_revision: Some(disk_revision.clone()),
                disk_revision: Some(disk_revision),
                dirty: false,
                views: 0,
                draft_active: None,
                undo: Vec::new(),
                redo: Vec::new(),
            },
        );
        Ok(id)
    }

    pub fn get(&self) -> Vec<DocId> {
        self.lock().docs.keys().cloned().collect()
    }

    /// Find the doc id registered at this canonical path, if any
    /// (multi-window: the second opener reuses the entry, FR-043/AT-117).
    pub fn find_by_path(&self, path: &Path) -> Option<DocId> {
        let key = path.to_string_lossy().into_owned();
        self.lock().docs.get(&key).map(|_| key)
    }

    pub fn snapshot(&self, id: &str) -> Option<DocumentSnapshot> {
        let inner = self.lock();
        let e = inner.docs.get(id)?;
        Some(DocumentSnapshot {
            doc_id: id.to_string(),
            path: e.path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            content: e.content.clone(),
            bom: e.bom,
            newline: e.newline,
            revision: e.revision,
            saved_content_hash: e
                .saved_revision
                .as_ref()
                .map(|r| r.content_hash.clone()),
            saved_disk_revision: e.saved_revision.clone(),
            disk_revision: e.disk_revision.clone(),
            dirty: e.is_dirty(),
            draft_active: e.draft_active.clone(),
        })
    }

    /// View bookkeeping for multi-window ownership (AT-117).
    pub fn acquire_view(&self, id: &str) -> Result<u32, String> {
        let mut inner = self.lock();
        let e = inner.docs.get_mut(id).ok_or_else(|| format!("unknown document {id}"))?;
        e.views += 1;
        Ok(e.views)
    }

    /// Returns true when the last view was released.
    pub fn release_view(&self, id: &str) -> Result<u32, String> {
        let mut inner = self.lock();
        let e = inner.docs.get_mut(id).ok_or_else(|| format!("unknown document {id}"))?;
        if e.views == 0 {
            return Err(format!("no views to release for {id}"));
        }
        e.views -= 1;
        Ok(e.views)
    }

    /// Set/clear the inline-draft flag (ADR-008).
    pub fn set_draft_active(&self, id: &str, token: Option<String>) -> Result<(), String> {
        let mut inner = self.lock();
        let e = inner.docs.get_mut(id).ok_or_else(|| format!("unknown document {id}"))?;
        e.draft_active = token;
        Ok(())
    }

    pub fn is_dirty(&self, id: &str) -> Option<bool> {
        self.lock().docs.get(id).map(|e| e.is_dirty())
    }

    pub fn disk_changed(&self, id: &str, new_rev: DiskRevision) -> bool {
        let mut inner = self.lock();
        match inner.docs.get_mut(id) {
            Some(e) => {
                let changed = match e.disk_revision.as_ref() {
                    None => true,
                    Some(prev) => {
                        prev.content_hash != new_rev.content_hash
                            || prev.size_bytes != new_rev.size_bytes
                    }
                };
                if changed {
                    e.disk_revision = Some(new_rev);
                }
                changed
            }
            None => false,
        }
    }

    /// Record a successful save (service::save_atomic succeeded).
    pub fn mark_saved(&self, id: &str, rev: crate::documents::service::DiskRevision) -> Result<(), String> {
        let mut inner = self.lock();
        let e = inner.docs.get_mut(id).ok_or_else(|| format!("unknown document {id}"))?;
        e.saved_revision = Some(rev.clone());
        e.disk_revision = Some(rev);
        e.dirty = false;
        Ok(())
    }

    /// Update the BOM/newline flags (used by confirmed reloads).
    pub fn set_meta(&self, id: &str, bom: bool, newline: NewlinePolicy) -> Result<(), String> {
        let mut inner = self.lock();
        let e = inner.docs.get_mut(id).ok_or_else(|| format!("unknown document {id}"))?;
        e.bom = bom;
        e.newline = newline;
        Ok(())
    }

    /// Repoint a document at a new path (save-as).
    pub fn rename_document(&self, id: &str, new_path: String) -> Result<(), String> {
        let mut inner = self.lock();
        let e = inner.docs.get_mut(id).ok_or_else(|| format!("unknown document {id}"))?;
        e.path = Some(std::path::PathBuf::from(new_path));
        Ok(())
    }

    /// Canonical on-disk bytes of the buffer (BOM included) — what a save
    /// would write.
    pub fn canonical_bytes(&self, id: &str) -> Option<Vec<u8>> {
        let inner = self.lock();
        let e = inner.docs.get(id)?;
        Some(e.file_bytes())
    }

    /// Drop a document from the registry. Called only after the close
    /// coordinator has resolved drafts + dirty state (ADR-008).
    pub fn dispose(&self, id: &str) -> bool {
        let mut inner = self.lock();
        if inner.docs.get(id).is_some_and(|entry| entry.views > 0) {
            return false;
        }
        inner.docs.remove(id).is_some()
    }

    /// The core mutation path (ADR-006). Validates, applies, records the
    /// undo group, and returns the ops for broadcast.
    pub fn apply_transaction(
        &self,
        id: &str,
        tx: &WireTransaction,
    ) -> Result<TransactionRecord, crate::documents::ApplyError> {
        let mut inner = self.lock();
        let e = inner
            .docs
            .get_mut(id)
            .ok_or_else(|| crate::documents::ApplyError::UnknownDoc(id.to_string()))?;

        if tx.base_revision != e.revision {
            return Err(crate::documents::ApplyError::StaleRevision {
                expected: e.revision,
                actual: tx.base_revision,
            });
        }
        if tx.ops.is_empty() {
            return Err(crate::documents::ApplyError::InvalidOp(
                OpValidationError::OutOfOrder(0),
            ));
        }

        let len = e.content.len() as u32;
        let mut applied: Vec<AppliedOp> = Vec::with_capacity(tx.ops.len());
        let mut cursor: u32 = 0;

        for (i, op) in tx.ops.iter().enumerate() {
            if op.start_byte < cursor {
                return Err(crate::documents::ApplyError::InvalidOp(
                    OpValidationError::OutOfOrder(i),
                ));
            }
            if op.end_byte > len {
                return Err(crate::documents::ApplyError::InvalidOp(
                    OpValidationError::OutOfBounds {
                        end_byte: op.end_byte,
                        len: e.content.len(),
                    },
                ));
            }
            if op.end_byte < op.start_byte {
                return Err(crate::documents::ApplyError::InvalidOp(
                    OpValidationError::Inverted {
                        start: op.start_byte,
                        end: op.end_byte,
                    },
                ));
            }
            if !e.content.is_char_boundary(op.start_byte as usize) {
                return Err(crate::documents::ApplyError::InvalidOp(
                    OpValidationError::NotCharBoundary(op.start_byte),
                ));
            }
            if !e.content.is_char_boundary(op.end_byte as usize) {
                return Err(crate::documents::ApplyError::InvalidOp(
                    OpValidationError::NotCharBoundary(op.end_byte),
                ));
            }
            let old = e.content[op.start_byte as usize..op.end_byte as usize].to_string();
            applied.push(AppliedOp {
                start_byte: op.start_byte,
                end_byte: op.end_byte,
                text: op.text.clone(),
                old_text: old,
            });
            cursor = op.end_byte;
        }

        // Apply in reverse order so earlier offsets stay valid.
        for op in applied.iter().rev() {
            e.content.replace_range(
                op.start_byte as usize..op.end_byte as usize,
                &op.text,
            );
        }

        e.revision += 1;
        e.dirty = true;
        let record = TransactionRecord {
            revision: e.revision,
            ops: applied,
        };
        e.undo.push(record.clone());
        e.redo.clear();
        Ok(record)
    }

    /// Undo the last transaction; returns inverse operations at the new revision.
    pub fn undo(&self, id: &str) -> Result<Option<TransactionRecord>, String> {
        let mut inner = self.lock();
        let e = inner.docs.get_mut(id).ok_or_else(|| format!("unknown document {id}"))?;
        let record = match e.undo.pop() {
            None => return Ok(None),
            Some(r) => r,
        };
        // Inverse ranges address the post-edit buffer, including the byte
        // shifts introduced by earlier operations in the original batch.
        let mut shift: i64 = 0;
        let ops: Vec<AppliedOp> = record.ops.iter().map(|op| {
            let start = (i64::from(op.start_byte) + shift) as u32;
            shift += op.text.len() as i64 - i64::from(op.end_byte - op.start_byte);
            AppliedOp {
                start_byte: start,
                end_byte: start + op.text.len() as u32,
                text: op.old_text.clone(),
                old_text: op.text.clone(),
            }
        }).collect();
        for op in ops.iter().rev() {
            e.content.replace_range(op.start_byte as usize..op.end_byte as usize, &op.text);
        }
        e.revision += 1;
        e.recompute_dirty();
        e.redo.push(record);
        Ok(Some(TransactionRecord { revision: e.revision, ops }))
    }

    pub fn redo(&self, id: &str) -> Result<Option<TransactionRecord>, String> {
        let mut inner = self.lock();
        let e = inner.docs.get_mut(id).ok_or_else(|| format!("unknown document {id}"))?;
        let record = match e.redo.pop() {
            None => return Ok(None),
            Some(r) => r,
        };
        for op in record.ops.iter().rev() {
            e.content.replace_range(op.start_byte as usize..op.end_byte as usize, &op.text);
        }
        e.revision += 1;
        e.recompute_dirty();
        e.undo.push(record.clone());
        Ok(Some(TransactionRecord { revision: e.revision, ops: record.ops }))
    }

    pub fn can_undo(&self, id: &str) -> Option<bool> {
        self.lock().docs.get(id).map(|e| !e.undo.is_empty())
    }

    pub fn can_redo(&self, id: &str) -> Option<bool> {
        self.lock().docs.get(id).map(|e| !e.redo.is_empty())
    }
}

/// Recompute the wire ops (without pre-image) from an applied record, for
/// broadcast payloads and tests.
pub fn wire_ops(record: &TransactionRecord) -> Vec<DocOp> {
    record
        .ops
        .iter()
        .map(|o| DocOp {
            start_byte: o.start_byte,
            end_byte: o.end_byte,
            text: o.text.clone(),
        })
        .collect()
}

