//! Crash-recovery snapshots (ADR-004, FR-006).
//!
//! Snapshots live in the app-data directory, **separate from the original
//! file**, are written atomically (temp + rename so a crash never tears one),
//! are opt-in to restore, and are cleaned on successful save / explicit
//! discard. A bounded LRU-by-age quota evicts the oldest snapshots.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::{DiskRevision, DocumentRegistry, DraftLease, NewlinePolicy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;

const META_SUFFIX: &str = ".meta.json";
const SNAP_SUFFIX: &str = ".snap";
const DEFAULT_QUOTA_BYTES: u64 = 500 * 1024 * 1024;
static SESSION_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const MAX_RECORD_BYTES: u64 = 64 * 1024 * 1024;

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryInfo {
    pub key: String,
    /// Path of the document the snapshot belongs to (None for untitled).
    pub path: Option<String>,
    pub created_at: u64,
    pub content_bytes: u64,
    pub revision: u64,
    /// Inline draft text if a modified draft was open when the snapshot was
    /// taken (ADR-008: draft content is recoverable too).
    pub has_draft: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Meta {
    pub path: Option<String>,
    pub created_at: u64,
    pub revision: u64,
    pub draft: Option<String>,
    #[serde(default)]
    pub context: Option<RecoveryContext>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryContext {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub conflicted: bool,
    pub doc_id: String,
    pub bom: bool,
    pub newline: NewlinePolicy,
    pub saved_disk_revision: Option<DiskRevision>,
    pub draft: Option<DraftLease>,
}

#[derive(Serialize, Deserialize)]
struct Record {
    version: u32,
    bytes: Vec<u8>,
    hash: String,
    meta: Meta,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredDocument {
    pub doc_id: String,
    pub has_draft: bool,
    pub conflicted: bool,
    pub draft_copy_id: Option<String>,
}

pub struct RecoveryStore {
    base_dir: PathBuf,
    quota_bytes: u64,
    io: Mutex<()>,
    session_id: String,
}

impl RecoveryStore {
    /// Opt-in only. Always recover into new untitled documents; never touch the
    /// source path or attach a captured range to a changed base.
    pub fn restore_document(
        &self,
        key: &str,
        registry: &DocumentRegistry,
        visual: bool,
    ) -> Result<RestoredDocument, String> {
        let (bytes, meta) = self.read(key).map_err(|e| e.to_string())?;
        let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
        let text = String::from_utf8(bytes[if bom { 3 } else { 0 }..].to_vec())
            .map_err(|e| e.to_string())?;
        let newline = meta
            .context
            .as_ref()
            .map(|context| context.newline)
            .unwrap_or_else(|| super::service::detect_newline(&text));
        if meta
            .context
            .as_ref()
            .is_some_and(|context| context.bom != bom)
        {
            return Err("recovery encoding metadata does not match its bytes".into());
        }
        let mut conflicted = meta.context.as_ref().is_some_and(|context| {
            context.conflicted
                || match (&meta.path, &context.saved_disk_revision) {
                    (Some(path), Some(saved)) => super::service::disk_revision(Path::new(path))
                        .map_or(true, |disk| {
                            disk.content_hash != saved.content_hash
                                || disk.size_bytes != saved.size_bytes
                        }),
                    _ => false,
                }
        });
        let mut draft = meta
            .context
            .and_then(|context| context.draft.map(|draft| (context.doc_id, draft)));
        if draft.as_ref().is_some_and(|(source_id, lease)| {
            lease.doc_id != *source_id
                || lease.opening.base_revision != meta.revision
                || text.get(lease.opening.start_byte as usize..lease.opening.end_byte as usize)
                    != Some(lease.opening.opening_text.as_str())
        }) {
            conflicted = true;
        }
        let id = registry.create_recovered(text, bom, newline);
        let mut has_draft = false;
        let mut draft_copy_id = None;
        if !conflicted && visual {
            if let Some((_, lease)) = draft.take() {
                registry.restore_draft(&id, lease)?;
                has_draft = true;
            }
        }
        if !has_draft {
            let text = draft.map(|(_, lease)| lease.text).or(meta.draft);
            if let Some(text) = text {
                conflicted = true;
                draft_copy_id = Some(registry.create_recovered(text, false, newline));
            }
        }
        if conflicted {
            registry.mark_recovery_conflicted(&id);
            if let Some(copy) = &draft_copy_id {
                registry.mark_recovery_conflicted(copy);
            }
        }
        self.persist_document(registry, &id)
            .map_err(|e| e.to_string())?;
        if let Some(copy_id) = &draft_copy_id {
            self.persist_document(registry, copy_id)
                .map_err(|e| e.to_string())?;
        }
        self.remove(key);
        Ok(RestoredDocument {
            doc_id: id,
            has_draft,
            conflicted,
            draft_copy_id,
        })
    }
    pub fn new(base_dir: impl Into<PathBuf>) -> Self {
        let base_dir = base_dir.into();
        let _ = std::fs::create_dir_all(&base_dir);
        Self {
            base_dir,
            quota_bytes: DEFAULT_QUOTA_BYTES,
            io: Mutex::new(()),
            session_id: format!(
                "{}-{}-{}",
                std::process::id(),
                Self::now_ms(),
                SESSION_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            ),
        }
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Derive a stable key from the document path (or untitled id) so a
    /// snapshot can never be keyed by user-visible names with separators.
    pub fn key_for(path: &Option<PathBuf>, untitled_id: &str) -> String {
        match path {
            Some(p) => {
                let mut h = Sha256::new();
                h.update(p.as_os_str().as_encoded_bytes());
                format!("{:x}", h.finalize())
            }
            None => format!("untitled-{untitled_id}"),
        }
    }

    pub fn document_key(&self, path: &Option<PathBuf>, id: &str) -> String {
        // A new session's timer/save must never replace an earlier crash record
        // that the user has chosen to leave for later restoration.
        format!("{}-{}", Self::key_for(path, id), self.session_id)
    }

    /// Write a snapshot atomically. `content` is the full file bytes (BOM
    /// included) as the canonical buffer currently stands.
    pub fn snapshot(
        &self,
        key: &str,
        path: Option<&Path>,
        content: &[u8],
        revision: u64,
        draft: Option<String>,
    ) -> Result<RecoveryInfo, std::io::Error> {
        let _guard = self.io.lock().expect("recovery writes");
        let meta = Meta {
            path: path.map(|p| p.to_string_lossy().into_owned()),
            created_at: Self::now_ms(),
            revision,
            draft,
            context: None,
        };
        self.write_record(key, content, meta)
    }

    fn checked_key(key: &str) -> Result<(), std::io::Error> {
        if key.is_empty()
            || key.len() > 160
            || !key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "invalid recovery key",
            ));
        }
        Ok(())
    }

    fn record_hash(bytes: &[u8], meta: &Meta) -> Result<String, std::io::Error> {
        let mut digest = Sha256::new();
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
        digest.update(serde_json::to_vec(meta)?);
        Ok(format!("{:x}", digest.finalize()))
    }

    fn write_record(
        &self,
        key: &str,
        content: &[u8],
        meta: Meta,
    ) -> Result<RecoveryInfo, std::io::Error> {
        Self::checked_key(key)?;
        std::fs::create_dir_all(&self.base_dir)?;
        let tmp = self.base_dir.join(format!("{key}.tmp"));
        let hash = Self::record_hash(content, &meta)?;
        let record = Record {
            version: 2,
            bytes: content.into(),
            hash,
            meta,
        };
        let encoded = serde_json::to_vec(&record)?;
        if encoded.len() as u64 > MAX_RECORD_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "recovery record exceeds its limit",
            ));
        }
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&encoded)?;
        file.sync_all()?;
        std::fs::rename(&tmp, self.base_dir.join(format!("{key}.record.json")))?;
        #[cfg(unix)]
        std::fs::File::open(&self.base_dir)?.sync_all()?;
        let meta = record.meta;
        let info = RecoveryInfo {
            key: key.to_string(),
            path: meta.path.clone(),
            created_at: meta.created_at,
            content_bytes: content.len() as u64,
            revision: meta.revision,
            has_draft: meta.draft.is_some(),
        };
        self.enforce_quota();
        Ok(info)
    }

    /// Capture under the I/O gate, so an old timer cannot overwrite a newer
    /// acknowledged draft or resurrect one after Apply/Cancel.
    pub fn persist_document(
        &self,
        registry: &DocumentRegistry,
        id: &str,
    ) -> Result<Option<RecoveryInfo>, std::io::Error> {
        let _guard = self.io.lock().expect("recovery writes");
        let Some((snapshot, lease, conflicted)) = registry.recovery_state(id) else {
            return Ok(None);
        };
        let path = snapshot.path.as_ref().map(PathBuf::from);
        let key = self.document_key(&path, id);
        let modified = lease.filter(|lease| lease.text != lease.opening.opening_text);
        if !snapshot.dirty && modified.is_none() {
            self.remove_files(&key);
            return Ok(None);
        }
        let mut bytes = Vec::new();
        if snapshot.bom {
            bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
        }
        bytes.extend_from_slice(snapshot.content.as_bytes());
        let meta = Meta {
            path: snapshot.path,
            created_at: Self::now_ms(),
            revision: snapshot.revision,
            draft: modified.as_ref().map(|lease| lease.text.clone()),
            context: Some(RecoveryContext {
                session_id: Some(self.session_id.clone()),
                conflicted,
                doc_id: snapshot.doc_id,
                bom: snapshot.bom,
                newline: snapshot.newline,
                saved_disk_revision: snapshot.saved_disk_revision,
                draft: modified,
            }),
        };
        self.write_record(&key, &bytes, meta).map(Some)
    }

    pub fn read(&self, key: &str) -> Result<(Vec<u8>, Meta), std::io::Error> {
        Self::checked_key(key)?;
        let record = self.base_dir.join(format!("{key}.record.json"));
        if record.exists() {
            if std::fs::metadata(&record)?.len() > MAX_RECORD_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "recovery record exceeds its limit",
                ));
            }
            let record: Record = serde_json::from_slice(&std::fs::read(record)?)?;
            if record.version != 2 || record.hash != Self::record_hash(&record.bytes, &record.meta)?
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "unsupported or corrupted recovery record",
                ));
            }
            return Ok((record.bytes, record.meta));
        }
        let snap = self.base_dir.join(format!("{key}{SNAP_SUFFIX}"));
        let meta = self.base_dir.join(format!("{key}{META_SUFFIX}"));
        let bytes = std::fs::read(&snap)?;
        let meta: Meta = serde_json::from_slice(&std::fs::read(&meta)?)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        Ok((bytes, meta))
    }

    pub fn remove(&self, key: &str) {
        let _guard = self.io.lock().expect("recovery writes");
        self.remove_files(key);
    }

    fn remove_files(&self, key: &str) {
        if Self::checked_key(key).is_err() {
            return;
        }
        let _ = std::fs::remove_file(self.base_dir.join(format!("{key}.record.json")));
        let _ = std::fs::remove_file(self.base_dir.join(format!("{key}{SNAP_SUFFIX}")));
        let _ = std::fs::remove_file(self.base_dir.join(format!("{key}{META_SUFFIX}")));
        let _ = std::fs::remove_file(self.base_dir.join(format!("{key}.tmp")));
    }

    pub fn list(&self) -> Vec<RecoveryInfo> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.base_dir) else {
            return out;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(key) = name.strip_suffix(".record.json") {
                if let Ok((bytes, meta)) = self.read(key) {
                    out.push(RecoveryInfo {
                        key: key.into(),
                        path: meta.path,
                        created_at: meta.created_at,
                        content_bytes: bytes.len() as u64,
                        revision: meta.revision,
                        has_draft: meta.draft.is_some(),
                    });
                }
                continue;
            }
            let Some(key) = name.strip_suffix(META_SUFFIX) else {
                continue;
            };
            if self.base_dir.join(format!("{key}.record.json")).exists() {
                continue;
            }
            let meta_path = entry.path();
            let Ok(meta_bytes) = std::fs::read(&meta_path) else {
                continue;
            };
            let Ok(meta) = serde_json::from_slice::<Meta>(&meta_bytes) else {
                continue;
            };
            let snap = self.base_dir.join(format!("{key}{SNAP_SUFFIX}"));
            let Ok(snap_meta) = std::fs::metadata(&snap) else {
                continue;
            };
            out.push(RecoveryInfo {
                key: key.to_string(),
                path: meta.path.clone(),
                created_at: meta.created_at,
                content_bytes: snap_meta.len(),
                revision: meta.revision,
                has_draft: meta.draft.is_some(),
            });
        }
        out.sort_by_key(|a| std::cmp::Reverse(a.created_at));
        out
    }

    /// Active-session snapshots are not crash-recovery offers in newly opened windows.
    pub fn list_for_restore(&self) -> Vec<RecoveryInfo> {
        self.list()
            .into_iter()
            .filter(|info| {
                self.read(&info.key)
                    .ok()
                    .and_then(|(_, meta)| meta.context.and_then(|context| context.session_id))
                    .as_deref()
                    != Some(&self.session_id)
            })
            .collect()
    }

    /// Evict oldest snapshots until under quota.
    fn enforce_quota(&self) {
        let mut total: u64 = 0;
        let infos = self.list();
        for i in &infos {
            total += self.record_size(i);
        }
        if total <= self.quota_bytes {
            return;
        }
        // infos are newest-first: evict from the back.
        for i in infos.iter().rev() {
            if total <= self.quota_bytes {
                break;
            }
            total = total.saturating_sub(self.record_size(i));
            self.remove_files(&i.key);
        }
    }

    fn record_size(&self, info: &RecoveryInfo) -> u64 {
        std::fs::metadata(self.base_dir.join(format!("{}.record.json", info.key)))
            .map(|meta| meta.len())
            .unwrap_or(info.content_bytes)
    }
}
