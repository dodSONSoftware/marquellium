//! WorkspaceService (ADR-005): scoped filesystem access.
//!
//! M1: path canonicalization + scope checks (traversal/symlink rejection)
//! and directory listing for the Files sidebar (M4) and workspace-wide
//! search (M5). The `local-media:` protocol (M2) reuses `resolve_in_scope`.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// True when the entry is a symlink (rendered distinctly; never
    /// followed for content in v1).
    pub is_symlink: bool,
    pub size: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum PathError {
    #[error("path is outside the allowed scope {0}")]
    OutsideScope(String),
    #[error("path contains NUL bytes")]
    NulByte,
    #[error("path does not exist: {0}")]
    NotFound(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Canonicalize `path` and require it (and its resolution) to stay inside
/// `scope`. Never a naive `starts_with`: comparison is on canonicalized
/// path components (§8.4).
pub fn resolve_in_scope(scope: &Path, path: &Path) -> Result<PathBuf, PathError> {
    if path.as_os_str().to_string_lossy().contains('\0') || scope.as_os_str().to_string_lossy().contains('\0')
    {
        return Err(PathError::NulByte);
    }
    let scope_canon = scope
        .canonicalize()
        .map_err(|_| PathError::NotFound(scope.display().to_string()))?;
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        scope_canon.join(path)
    };
    let canon = candidate
        .canonicalize()
        .map_err(|_| PathError::NotFound(candidate.display().to_string()))?;
    // Both are canonicalized (symlinks resolved, same form), so a component
    // prefix check is exact — never a naive string `starts_with`.
    if canon.strip_prefix(&scope_canon).is_err() {
        return Err(PathError::OutsideScope(scope_canon.display().to_string()));
    }
    Ok(canon)
}

/// Reject `..` segments outright even before canonicalization (defense in
/// depth; canonicalize already resolves them, but some filesystems report
/// them differently for missing targets).
pub fn contains_traversal(path: &Path) -> bool {
    path.components().any(|c| matches!(c, Component::ParentDir))
}

/// List a directory (non-recursive at one level) with exclusion of hidden
/// entries and user-configured patterns (M1: hidden only; FR-007 patterns
/// land in M4).
pub fn list_dir(root: &Path) -> Result<Vec<DirEntry>, PathError> {
    if !root.is_dir() {
        return Err(PathError::NotFound(root.display().to_string()));
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if file_name.starts_with('.') {
            continue;
        }
        let meta = entry.metadata()?;
        let is_symlink = entry.file_type()?.is_symlink();
        out.push(DirEntry {
            name: file_name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir() && !is_symlink,
            is_symlink,
            size: meta.len(),
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}
