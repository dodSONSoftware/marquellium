use super::DocumentRegistry;
use crate::documents::service::{
    disk_revision, save_as_atomic, save_atomic, DiskRevision, SaveError,
};
use std::path::{Path, PathBuf};

impl DocumentRegistry {
    pub fn reload_from_disk(
        &self,
        id: &str,
        expected: u64,
        allow_dirty: bool,
    ) -> Result<super::TransactionRecord, String> {
        let mut inner = self.lock();
        let entry = inner.docs.get_mut(id).ok_or("unknown document")?;
        if entry.draft.is_some() {
            return Err("resolve the active draft before reloading".into());
        }
        if entry.revision != expected || (!allow_dirty && entry.dirty) {
            return Err("document changed before reload; preserve its current content".into());
        }
        let path = entry
            .path
            .as_ref()
            .ok_or("untitled documents cannot be reloaded")?;
        let (content, bom, newline, revision) =
            crate::documents::service::open_document(path, false).map_err(|e| e.to_string())?;
        let transaction = crate::documents::WireTransaction {
            base_revision: entry.revision,
            ops: vec![crate::documents::DocOp {
                start_byte: 0,
                end_byte: entry.content.len() as u32,
                text: content,
            }],
        };
        let record = Self::apply_entry(entry, &transaction).map_err(|e| e.to_string())?;
        entry.bom = bom;
        entry.newline = newline;
        entry.saved_revision = Some(revision.clone());
        entry.disk_revision = Some(revision);
        entry.dirty = false;
        Ok(record)
    }

    pub fn create_recovered(
        &self,
        content: String,
        bom: bool,
        newline: super::NewlinePolicy,
    ) -> String {
        let id = self.create_untitled();
        let mut inner = self.lock();
        let entry = inner.docs.get_mut(&id).expect("new recovered document");
        entry.content = content;
        entry.bom = bom;
        entry.newline = newline;
        entry.dirty = true;
        id
    }
    /// Serialize the canonical snapshot, disk replacement, and saved metadata
    /// with edits and watcher observations. No observer sees a half-saved state.
    pub fn save_to_disk(
        &self,
        id: &str,
        target: Option<PathBuf>,
    ) -> Result<DiskRevision, SaveError> {
        let mut inner = self.lock();
        let entry = inner.docs.get_mut(id).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("unknown document {id}"),
            )
        })?;
        let bytes = entry.file_bytes();
        let revision = if let Some(path) = target {
            let expected = disk_revision(&path).ok();
            let revision = save_as_atomic(&path, &bytes, expected.as_ref())?;
            entry.path = Some(path);
            revision
        } else {
            let path = entry.path.as_ref().ok_or(SaveError::Untitled)?;
            save_atomic(path, &bytes, entry.saved_revision.as_ref())?
        };
        entry.saved_revision = Some(revision.clone());
        entry.disk_revision = Some(revision.clone());
        entry.dirty = false;
        Ok(revision)
    }

    /// Some(auto_reload) means a genuine disk change; None means no change.
    /// Read the file under the same lock as save, rather than compare a disk
    /// revision sampled before a concurrent save completed.
    pub fn observe_disk_change(&self, id: &str, path: &Path) -> Option<bool> {
        let mut inner = self.lock();
        let entry = inner.docs.get_mut(id)?;
        if entry.path.as_deref() != Some(path) {
            return None;
        }
        let revision = disk_revision(path).ok()?;
        if entry.disk_revision.as_ref().is_some_and(|previous| {
            previous.content_hash == revision.content_hash
                && previous.size_bytes == revision.size_bytes
        }) {
            return None;
        }
        entry.disk_revision = Some(revision);
        Some(!entry.dirty && entry.draft.is_none())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::documents::{service::open_document, DocOp, WireTransaction};
    use std::sync::{Arc, Barrier};

    fn opened() -> (tempfile::TempDir, PathBuf, Arc<DocumentRegistry>, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shared.md");
        std::fs::write(&path, "original").unwrap();
        let (text, bom, newline, revision) = open_document(&path, false).unwrap();
        let registry = Arc::new(DocumentRegistry::new());
        let id = registry
            .insert_opened(&path, text, bom, newline, revision)
            .unwrap();
        (dir, path, registry, id)
    }

    fn edit(registry: &DocumentRegistry, id: &str, text: &str) {
        let snapshot = registry.snapshot(id).unwrap();
        registry
            .apply_transaction(
                id,
                &WireTransaction {
                    base_revision: snapshot.revision,
                    ops: vec![DocOp {
                        start_byte: 0,
                        end_byte: snapshot.content.len() as u32,
                        text: text.into(),
                    }],
                },
            )
            .unwrap();
    }

    #[test]
    fn save_and_watcher_share_a_serialized_disk_observation() {
        let (_dir, path, registry, id) = opened();
        for n in 0..20 {
            edit(&registry, &id, &format!("saved {n}"));
            let start = Arc::new(Barrier::new(2));
            std::thread::scope(|scope| {
                let start_save = start.clone();
                let registry = &registry;
                let id = &id;
                scope.spawn(move || {
                    start_save.wait();
                    registry.save_to_disk(id, None).unwrap();
                });
                start.wait();
                for _ in 0..10 {
                    assert_eq!(registry.observe_disk_change(id, &path), None);
                }
            });
            let snapshot = registry.snapshot(&id).unwrap();
            assert!(!snapshot.dirty);
            assert_eq!(std::fs::read_to_string(&path).unwrap(), snapshot.content);
        }
        std::fs::write(&path, "external change").unwrap();
        assert_eq!(registry.observe_disk_change(&id, &path), Some(true));
        assert_eq!(registry.observe_disk_change(&id, &path), None);
    }

    #[test]
    fn failed_save_keeps_dirty_content_and_saved_revision() {
        let (_dir, path, registry, id) = opened();
        let saved = registry.snapshot(&id).unwrap().saved_disk_revision;
        edit(&registry, &id, "local change");
        std::fs::write(&path, "external change").unwrap();
        assert_eq!(registry.observe_disk_change(&id, &path), Some(false));
        assert!(registry.save_to_disk(&id, None).unwrap_err().is_conflict());
        let snapshot = registry.snapshot(&id).unwrap();
        assert!(snapshot.dirty);
        assert_eq!(snapshot.content, "local change");
        assert_eq!(snapshot.saved_disk_revision, saved);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "external change");
    }

    #[test]
    fn reload_refuses_stale_revisions_dirty_auto_reload_and_active_drafts() {
        let (_dir, path, registry, id) = opened();
        edit(&registry, &id, "local change");
        std::fs::write(&path, "external change").unwrap();
        assert!(registry.reload_from_disk(&id, 1, false).is_err());
        assert!(registry.reload_from_disk(&id, 0, true).is_err());
        let lease = registry
            .acquire_draft(
                &id,
                "owner",
                super::super::DraftOpening {
                    base_revision: 1,
                    start_byte: 0,
                    end_byte: 12,
                    opening_text: "local change".into(),
                    kind: super::super::DraftKind::Source,
                },
            )
            .unwrap();
        assert!(registry.reload_from_disk(&id, 1, true).is_err());
        assert_eq!(registry.snapshot(&id).unwrap().content, "local change");
        registry.release_draft(&id, "owner", &lease.token).unwrap();
        registry.reload_from_disk(&id, 1, true).unwrap();
        assert_eq!(registry.snapshot(&id).unwrap().content, "external change");
        registry.undo(&id).unwrap();
        assert_eq!(registry.snapshot(&id).unwrap().content, "local change");
    }

    #[test]
    fn save_as_publishes_path_only_after_success_and_preserves_history() {
        let (dir, old_path, registry, id) = opened();
        edit(&registry, &id, "saved elsewhere");
        let target = dir.path().join("new.md");
        registry.save_to_disk(&id, Some(target.clone())).unwrap();
        assert_eq!(
            registry.snapshot(&id).unwrap().path.as_deref(),
            target.to_str()
        );
        assert_eq!(registry.observe_disk_change(&id, &target), None);
        assert_eq!(registry.observe_disk_change(&id, &old_path), None);
        assert_eq!(std::fs::read_to_string(old_path).unwrap(), "original");
        registry.undo(&id).unwrap();
        assert!(registry.snapshot(&id).unwrap().dirty);
        let missing = dir.path().join("missing").join("file.md");
        assert!(registry.save_to_disk(&id, Some(missing)).is_err());
        assert_eq!(
            registry.snapshot(&id).unwrap().path.as_deref(),
            target.to_str()
        );
    }
}
