//! Crash-recovery snapshots (ADR-004, FR-006).
//!
//! Snapshots live in the app-data directory, **separate from the original
//! file**, are written atomically (temp + rename so a crash never tears one),
//! are opt-in to restore, and are cleaned on successful save / explicit
//! discard. A bounded LRU-by-age quota evicts the oldest snapshots.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const META_SUFFIX: &str = ".meta.json";
const SNAP_SUFFIX: &str = ".snap";
const DEFAULT_QUOTA_BYTES: u64 = 500 * 1024 * 1024;

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
}

pub struct RecoveryStore {
    base_dir: PathBuf,
    quota_bytes: u64,
}

impl RecoveryStore {
    pub fn new(base_dir: impl Into<PathBuf>) -> Self {
        let base_dir = base_dir.into();
        let _ = std::fs::create_dir_all(&base_dir);
        Self {
            base_dir,
            quota_bytes: DEFAULT_QUOTA_BYTES,
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
        std::fs::create_dir_all(&self.base_dir)?;
        let snap_path = self.base_dir.join(format!("{key}{SNAP_SUFFIX}"));
        let meta_path = self.base_dir.join(format!("{key}{META_SUFFIX}"));
        let tmp = self.base_dir.join(format!("{key}.tmp"));

        std::fs::write(&tmp, content)?;
        let mut f = std::fs::File::options()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&meta_path)?;
        use std::io::Write as _;
        let has_draft = draft.is_some();
        let meta = Meta {
            path: path.map(|p| p.to_string_lossy().into_owned()),
            created_at: Self::now_ms(),
            revision,
            draft,
        };
        f.write_all(&serde_json::to_vec(&meta).unwrap())?;
        f.sync_all()?;
        std::fs::rename(&tmp, &snap_path)?;

        let info = RecoveryInfo {
            key: key.to_string(),
            path: path.map(|p| p.to_string_lossy().into_owned()),
            created_at: meta.created_at,
            content_bytes: content.len() as u64,
            revision,
            has_draft,
        };
        self.enforce_quota();
        Ok(info)
    }

    pub fn read(&self, key: &str) -> Result<(Vec<u8>, Meta), std::io::Error> {
        let snap = self.base_dir.join(format!("{key}{SNAP_SUFFIX}"));
        let meta = self.base_dir.join(format!("{key}{META_SUFFIX}"));
        let bytes = std::fs::read(&snap)?;
        let meta: Meta = serde_json::from_slice(&std::fs::read(&meta)?)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        Ok((bytes, meta))
    }

    pub fn remove(&self, key: &str) {
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
            let Some(key) = name.strip_suffix(META_SUFFIX) else {
                continue;
            };
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

    /// Evict oldest snapshots until under quota.
    fn enforce_quota(&self) {
        let mut total: u64 = 0;
        let infos = self.list();
        for i in &infos {
            total += i.content_bytes;
        }
        if total <= self.quota_bytes {
            return;
        }
        // infos are newest-first: evict from the back.
        for i in infos.iter().rev() {
            if total <= self.quota_bytes {
                break;
            }
            total = total.saturating_sub(i.content_bytes);
            self.remove(&i.key);
        }
    }
}
