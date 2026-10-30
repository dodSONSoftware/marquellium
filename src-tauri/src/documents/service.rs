//! Document I/O (ADR-004, ADR-010):
//! - open: byte read → size guard → UTF-8 validation → BOM/newline detection
//! - save: temp write + sync → disk revision re-check → atomic rename
//! - disk revisions: mtime-ns + size + SHA-256 (timestamps alone are
//!   insufficient, PRD §8.3)

use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::documents::registry::NewlinePolicy;

/// Hard cap for opening documents (configurable later; ADR-010).
pub const MAX_OPEN_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskRevision {
    /// File mtime in nanoseconds since UNIX epoch (string to stay JSON-safe
    /// on all platforms).
    pub modified_at_ns: String,
    pub size_bytes: u64,
    /// SHA-256 (hex) of the full file bytes, BOM included.
    pub content_hash: String,
}

/// Snapshot handed to the frontend on open/sync (PRD §8.3 contract, with
/// registry additions).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    pub doc_id: String,
    pub path: Option<String>,
    pub content: String,
    pub bom: bool,
    pub newline: NewlinePolicy,
    pub revision: u64,
    pub saved_content_hash: Option<String>,
    pub saved_disk_revision: Option<DiskRevision>,
    pub disk_revision: Option<DiskRevision>,
    pub dirty: bool,
    pub draft_active: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub ok: bool,
    pub revision: Option<DiskRevision>,
    pub reason: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error("path does not exist or is not a file: {0}")]
    NotAFile(String),
    #[error("file exceeds the {0}-byte open limit")]
    TooLarge(u64),
    #[error("file is not valid UTF-8 (size {0} bytes); open with explicit conversion or convert the file first")]
    InvalidUtf8(u64),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, thiserror::Error)]
pub enum SaveError {
    #[error("conflict: the file on disk changed since it was opened (hash {0})")]
    Conflict(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("untitled document: use save_as")]
    Untitled,
}

impl SaveError {
    pub fn is_conflict(&self) -> bool {
        matches!(self, SaveError::Conflict(_))
    }
}

/// Compute a disk revision from an existing file.
pub fn disk_revision(path: &Path) -> Result<DiskRevision, std::io::Error> {
    let bytes = std::fs::read(path)?;
    disk_revision_bytes(&bytes).with_mtime(path)
}

/// Revision of a byte buffer, with mtime taken from `path`.
pub fn disk_revision_bytes_with_mtime(bytes: &[u8], path: &Path) -> Result<DiskRevision, std::io::Error> {
    disk_revision_bytes(bytes).with_mtime(path)
}

/// Compute the revision fields of a byte buffer (mtime set to 0; callers
/// attach the real mtime).
pub fn disk_revision_bytes(bytes: &[u8]) -> RevisionNoMtime {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    RevisionNoMtime {
        size_bytes: bytes.len() as u64,
        content_hash: format!("{:x}", hasher.finalize()),
    }
}

impl RevisionNoMtime {
    fn with_mtime(self, path: &Path) -> Result<DiskRevision, std::io::Error> {
        let mtime = std::fs::metadata(path)?.modified()?;
        let ns = mtime
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        Ok(DiskRevision {
            modified_at_ns: ns.to_string(),
            size_bytes: self.size_bytes,
            content_hash: self.content_hash,
        })
    }
}

#[allow(dead_code)] // part of the intended watcher-correlation API (M4)


#[derive(Debug, Clone)]
pub(crate) struct RevisionNoMtime {
    pub(crate) size_bytes: u64,
    pub(crate) content_hash: String,
}

/// Read and validate a document for opening. Returns canonical content
/// (BOM stripped), flags, and the disk revision.
///
/// `convert_latin1` selects the explicit conversion flow (ADR-004): bytes are
/// mapped losslessly as Latin-1 → Unicode. The original file is never touched.
pub fn open_document(
    path: &Path,
    convert_latin1: bool,
) -> Result<(String, bool, NewlinePolicy, DiskRevision), OpenError> {
    let meta = std::fs::metadata(path).map_err(|_| OpenError::NotAFile(path.display().to_string()))?;
    if !meta.is_file() {
        return Err(OpenError::NotAFile(path.display().to_string()));
    }
    let size = meta.len();
    if size > MAX_OPEN_BYTES {
        return Err(OpenError::TooLarge(size));
    }
    let bytes = std::fs::read(path)?;
    let rev = disk_revision_bytes_with_mtime(&bytes, path)?;

    let (content, bom) = match std::str::from_utf8(&bytes) {
        Ok(s) => {
            let s = s.as_bytes();
            if s.len() >= 3 && s[0] == 0xef && s[1] == 0xbb && s[2] == 0xbf {
                (String::from_utf8_lossy(&bytes[3..]).into_owned(), true)
            } else {
                (String::from_utf8(bytes).unwrap(), false)
            }
        }
        Err(_) if convert_latin1 => (
            bytes.iter().map(|&b| b as char).collect(),
            false,
        ),
        Err(_) => return Err(OpenError::InvalidUtf8(size)),
    };

    let newline = detect_newline(&content);
    Ok((content, bom, newline, rev))
}

/// Dominant line ending (ADR-010). No normalization anywhere — this only
/// picks the ending for *newly introduced* line breaks.
pub fn detect_newline(content: &str) -> NewlinePolicy {
    let mut crlf: u64 = 0;
    let mut lf: u64 = 0;
    let mut cr: u64 = 0;
    let mut chars = content.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => match chars.peek() {
                Some('\n') => {
                    chars.next();
                    crlf += 1;
                }
                _ => cr += 1,
            },
            '\n' => lf += 1,
            _ => {}
        }
    }
    match (crlf, lf, cr) {
        (0, 0, 0) => NewlinePolicy::None,
        _ => {
            let max = crlf.max(lf).max(cr);
            if max == crlf {
                NewlinePolicy::Crlf
            } else if max == lf {
                NewlinePolicy::Lf
            } else {
                NewlinePolicy::Cr
            }
        }
    }
}

/// Atomic, revision-checked save (ADR-004, §8.4):
/// 1. re-read the disk revision of `path`,
/// 2. compare against `expected` (if any) — mismatch ⇒ `Conflict`, no write,
/// 3. write a temp file in the same directory, sync, copy original permissions,
/// 4. rename over the target (atomic on the same filesystem),
/// 5. return the new disk revision.
pub fn save_atomic(
    path: &Path,
    bytes: &[u8],
    expected: Option<&DiskRevision>,
) -> Result<DiskRevision, SaveError> {

    let current = disk_revision(path)?;
    save_atomic_checked(path, bytes, Some(expected.unwrap_or(&current)), || {})
}

/// Explicit Save As may create a new target; ordinary Save requires one.
pub fn save_as_atomic(path: &Path, bytes: &[u8], expected: Option<&DiskRevision>) -> Result<DiskRevision, SaveError> {
    save_atomic_checked(path, bytes, expected, || {})
}

fn save_atomic_checked(
    path: &Path,
    bytes: &[u8],
    expected: Option<&DiskRevision>,
    before_replace: impl FnOnce(),
) -> Result<DiskRevision, SaveError> {
    let check = || -> Result<(), SaveError> {
        match (expected, disk_revision(path)) {
            (Some(exp), Ok(current)) if revisions_equal(exp, &current) => Ok(()),
            (None, Err(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            (_, Ok(current)) => Err(SaveError::Conflict(current.content_hash)),
            (_, Err(e)) => Err(SaveError::Io(e)),
        }
    };
    check()?;

    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(
        ".{}.mdviewer-tmp-{}",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        std::process::id()
    ));

    let result = (|| -> Result<DiskRevision, SaveError> {
        let mut f = std::fs::File::create(&tmp)?;
        use std::io::Write as _;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        // Preserve the original file's permissions where supported.
        if let Ok(meta) = std::fs::metadata(path) {
            std::fs::set_permissions(&tmp, meta.permissions())?;
        }
        before_replace();
        check()?;
        if expected.is_none() {
            // A hard link creates the new target atomically without replacing
            // a file another process created after the absence check.
            std::fs::hard_link(&tmp, path)?;
            std::fs::remove_file(&tmp)?;
        } else {
            std::fs::rename(&tmp, path)?;
        }
        // Best-effort directory sync (durability of the rename itself);
        // ignored on platforms where directories are not openable this way.
        if let Ok(dir_file) = std::fs::File::open(dir) {
            let _ = dir_file.sync_all();
        }
        Ok(disk_revision(path)?)
    })();

    match result {
        Ok(rev) => Ok(rev),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// A revision check helper for the watcher: did our own save cause the
/// event? (disk_revision equals saved_revision ⇒ yes, ignore).
#[allow(dead_code)] // part of the intended watcher-correlation API (M4)
pub fn revisions_equal(a: &DiskRevision, b: &DiskRevision) -> bool {
    a.content_hash == b.content_hash && a.size_bytes == b.size_bytes
}

#[cfg(test)]
mod save_regressions {
    use super::*;

    #[test]
    fn explicit_new_target_is_created_without_overwriting_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.md");
        save_as_atomic(&path, b"new", None).unwrap();
        assert!(save_as_atomic(&path, b"overwrite", None).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"new");
    }

    #[test]
    fn new_target_created_during_save_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.md");
        let result = save_atomic_checked(&path, b"ours", None, || {
            std::fs::write(&path, b"external").unwrap();
        });
        assert!(result.is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"external");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn external_change_during_temp_write_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("existing.md");
        std::fs::write(&path, b"original").unwrap();
        let expected = disk_revision(&path).unwrap();
        let result = save_atomic_checked(&path, b"ours", Some(&expected), || {
            std::fs::write(&path, b"external").unwrap();
        });
        assert!(matches!(result, Err(SaveError::Conflict(_))));
        assert_eq!(std::fs::read(path).unwrap(), b"external");
    }
}
