//! WorkspaceService (ADR-005): scoped filesystem access.
//!
//! M1: path canonicalization + scope checks (traversal/symlink rejection)
//! and directory listing for the Files sidebar (M4) and workspace-wide
//! search (M4). The `local-media:` protocol (M2) reuses `resolve_in_scope`.

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
    if path.as_os_str().to_string_lossy().contains('\0')
        || scope.as_os_str().to_string_lossy().contains('\0')
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
    for (scanned, entry) in std::fs::read_dir(root)?.enumerate() {
        if scanned >= 10_000 {
            return Err(PathError::Io(std::io::Error::other(
                "Directory scan limit exceeded; choose a narrower folder",
            )));
        }
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

/// Roots are granted by the native folder picker, separately for each window.
#[derive(Default)]
pub struct WorkspaceScopes(std::sync::Mutex<std::collections::HashMap<String, PathBuf>>);
impl WorkspaceScopes {
    pub fn grant(&self, window: &str, root: &Path) -> Result<PathBuf, PathError> {
        let root = root.canonicalize()?;
        if !root.is_dir() {
            return Err(PathError::NotFound(root.display().to_string()));
        }
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("workspace lock"))?
            .insert(window.into(), root.clone());
        Ok(root)
    }
    pub fn revoke(&self, window: &str) {
        if let Ok(mut scopes) = self.0.lock() {
            scopes.remove(window);
        }
    }
    pub fn root(&self, window: &str) -> Option<PathBuf> {
        self.0.lock().ok()?.get(window).cloned()
    }
}

/// Small bounded glob matcher: '*' matches a component, '**' spans directories.
/// No regex compilation or filesystem access from user patterns.
pub fn excluded(path: &str, patterns: &[String]) -> bool {
    fn matches(pattern: &[char], value: &[char]) -> bool {
        let mut previous = vec![false; value.len() + 1];
        previous[0] = true;
        let mut i = 0;
        while i < pattern.len() {
            let token = pattern[i];
            let double = token == '*' && pattern.get(i + 1) == Some(&'*');
            if double {
                i += 1;
            }
            let mut current = vec![false; value.len() + 1];
            if token == '*' {
                current[0] = previous[0];
            }
            for j in 1..=value.len() {
                current[j] = if token == '*' {
                    previous[j] || current[j - 1] && (double || value[j - 1] != '/')
                } else {
                    previous[j - 1]
                        && (token == '?' && value[j - 1] != '/' || token == value[j - 1])
                };
            }
            previous = current;
            i += 1;
        }
        previous[value.len()]
    }
    patterns.iter().take(100).any(|p| {
        p.len() <= 256
            && (matches(
                &p.chars().collect::<Vec<_>>(),
                &path.chars().collect::<Vec<_>>(),
            ) || !p.contains('/')
                && path.split('/').any(|part| {
                    matches(
                        &p.chars().collect::<Vec<_>>(),
                        &part.chars().collect::<Vec<_>>(),
                    )
                }))
    })
}

pub fn list_scoped(
    scope: &Path,
    directory: &Path,
    patterns: &[String],
) -> Result<Vec<DirEntry>, PathError> {
    let directory = resolve_in_scope(scope, directory)?;
    let mut entries = list_dir(&directory)?;
    if patterns.len() > 32
        || patterns.iter().map(String::len).sum::<usize>() > 2048
        || patterns.iter().any(|pattern| pattern.len() > 256)
    {
        return Err(PathError::Io(std::io::Error::other(
            "Use at most 32 exclusion patterns, 256 bytes each, 2048 bytes total",
        )));
    }
    let mut budget = 8_000_000usize;
    let weight = patterns.iter().map(String::len).sum::<usize>();
    let mut visible = Vec::new();
    for entry in entries.drain(..) {
        if entry.is_symlink
            || !entry.is_dir
                && !["md", "markdown", "txt"]
                    .iter()
                    .any(|ext| entry.name.to_lowercase().ends_with(&format!(".{ext}")))
        {
            continue;
        }
        let relative = Path::new(&entry.path)
            .strip_prefix(scope)
            .unwrap_or(Path::new(&entry.name))
            .to_string_lossy()
            .replace('\\', "/");
        let cost = relative.len().saturating_mul(weight).saturating_mul(2);
        budget = budget.checked_sub(cost).ok_or_else(|| {
            PathError::Io(std::io::Error::other(
                "Exclusion matching budget exceeded; simplify patterns or choose a narrower folder",
            ))
        })?;
        if !excluded(&relative, patterns) {
            visible.push(entry);
        }
    }
    let entries = visible;
    if entries.len() > 2000 {
        return Err(PathError::Io(std::io::Error::other(
            "Directory exceeds 2000 visible entries; choose a narrower folder",
        )));
    }
    Ok(entries)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub preview: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub matches: Vec<SearchMatch>,
    pub skipped_files: usize,
    pub truncated: bool,
}

/// Literal, case-sensitive disk search. Never follows symlinks; all traversal
/// uses the same picker scope and exclusions as the tree. Resource exhaustion
/// is explicit rather than silently claiming an exhaustive result.
pub fn search(scope: &Path, query: &str, patterns: &[String]) -> Result<SearchResults, String> {
    use std::io::Read;
    if query.trim().is_empty() || query.len() > 256 || query.contains(['\n', '\r', '\0']) {
        return Err("Search requires 1–256 bytes on one line".into());
    }
    let mut pending = vec![(scope.to_path_buf(), 0usize)];
    let mut results = SearchResults {
        matches: Vec::new(),
        skipped_files: 0,
        truncated: false,
    };
    let mut directories = 0;
    let mut files = 0;
    let mut bytes = 0usize;
    while let Some((directory, depth)) = pending.pop() {
        directories += 1;
        if directories > 1000 || depth > 16 {
            return Err(
                "Workspace search directory limit exceeded; choose a narrower folder".into(),
            );
        }
        for entry in list_scoped(scope, &directory, patterns).map_err(|e| e.to_string())? {
            if entry.is_dir {
                pending.push((PathBuf::from(entry.path), depth + 1));
                continue;
            }
            files += 1;
            if files > 2000 {
                return Err(
                    "Workspace search file limit exceeded; choose a narrower folder".into(),
                );
            }
            let path =
                resolve_in_scope(scope, Path::new(&entry.path)).map_err(|e| e.to_string())?;
            let mut content = Vec::new();
            std::fs::File::open(&path)
                .map_err(|e| e.to_string())?
                .take(1024 * 1024 + 1)
                .read_to_end(&mut content)
                .map_err(|e| e.to_string())?;
            bytes += content.len();
            if bytes > 16 * 1024 * 1024 {
                return Err("Workspace search exceeds 16 MiB; choose a narrower folder".into());
            }
            if content.len() > 1024 * 1024 {
                results.skipped_files += 1;
                continue;
            }
            let Ok(content) = String::from_utf8(content) else {
                results.skipped_files += 1;
                continue;
            };
            for (index, line) in content.lines().enumerate() {
                if let Some(offset) = line.find(query) {
                    if results.matches.len() == 200 {
                        results.truncated = true;
                        return Ok(results);
                    }
                    // Keep long-line results useful without returning entire files.
                    let start = line[..offset]
                        .char_indices()
                        .rev()
                        .nth(40)
                        .map_or(0, |(i, _)| i);
                    results.matches.push(SearchMatch {
                        path: entry.path.clone(),
                        line: index + 1,
                        preview: line[start..].chars().take(240).collect(),
                    });
                }
            }
        }
    }
    Ok(results)
}

pub fn resolve_link(
    document: &Path,
    workspace: Option<&Path>,
    href: &str,
) -> Result<(PathBuf, Option<String>), String> {
    if href.len() > 4096 || href.contains(['\0', '\\']) {
        return Err("Invalid local link".into());
    }
    let (target, fragment) = href
        .split_once('#')
        .map_or((href, None), |(a, b)| (a, Some(b)));
    let target = target.split('?').next().unwrap_or("");
    let decoded = crate::media::percent_decode(target).ok_or("Invalid percent-encoded link")?;
    let fragment = fragment
        .map(|f| crate::media::percent_decode(f).ok_or("Invalid anchor"))
        .transpose()?;
    if decoded.contains(':') || decoded.starts_with('/') || decoded.contains(['\0', '\\']) {
        return Err("Only relative local links are supported".into());
    }
    let document = document.canonicalize().map_err(|e| e.to_string())?;
    let parent = document.parent().ok_or("Document has no parent")?;
    let candidate = if decoded.is_empty() {
        document.clone()
    } else {
        parent.join(decoded)
    };
    let workspace = workspace.and_then(|root| root.canonicalize().ok());
    let scope = workspace
        .as_deref()
        .filter(|root| document.starts_with(root))
        .unwrap_or(parent);
    let resolved = resolve_in_scope(scope, &candidate).map_err(|e| e.to_string())?;
    if !resolved.is_file() {
        return Err("Link target is not a file".into());
    }
    Ok((resolved, fragment))
}

#[cfg(test)]
mod m4_tests {
    use super::*;
    #[test]
    fn patterns_and_scoped_markdown_listing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("notes")).unwrap();
        for name in ["a.md", "b.txt", "c.png", "hidden.md"] {
            std::fs::write(dir.path().join(name), "").unwrap();
        }
        let entries = list_scoped(dir.path(), dir.path(), &["hidden*".into()]).unwrap();
        assert_eq!(
            entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["notes", "a.md", "b.txt"]
        );
        assert!(excluded("a/vendor/x.md", &["**/vendor/**".into()]));
        assert!(excluded("a/node_modules/x", &["node_modules".into()]));
        assert!(!excluded("a.md", &["*.png".into()]));
        assert!(excluded("東京.md", &["??.md".into()]));
        assert!(list_scoped(dir.path(), dir.path(), &vec!["*".into(); 33]).is_err());
        assert!(list_scoped(dir.path(), dir.path(), &["*".repeat(257)]).is_err());
        assert!(list_scoped(dir.path(), &dir.path().join(".."), &[]).is_err());
    }
    #[test]
    fn relative_link_scopes_and_percent_encoding() {
        let root = tempfile::tempdir().unwrap();
        let notes = root.path().join("notes");
        std::fs::create_dir(&notes).unwrap();
        let doc = notes.join("a.md");
        let target = root.path().join("b space.md");
        std::fs::write(&doc, "").unwrap();
        std::fs::write(&target, "# Hello").unwrap();
        assert!(resolve_link(&doc, None, "../b%20space.md#hello").is_err());
        assert_eq!(
            resolve_link(&doc, Some(root.path()), "../b%20space.md#hello").unwrap(),
            (target.canonicalize().unwrap(), Some("hello".into()))
        );
        for bad in [
            "javascript:alert(1)",
            "%2Fetc/passwd",
            "%00",
            "%GG",
            "missing.md",
            "\\etc",
        ] {
            assert!(resolve_link(&doc, Some(root.path()), bad).is_err(), "{bad}");
        }
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_never_appear_or_escape() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let doc = root.path().join("a.md");
        std::fs::write(&doc, "").unwrap();
        std::fs::write(outside.path().join("secret.md"), "").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
        assert!(resolve_link(&doc, None, "link/secret.md").is_err());
        assert!(!list_scoped(root.path(), root.path(), &[])
            .unwrap()
            .iter()
            .any(|e| e.name == "link"));
    }
}

#[cfg(test)]
mod window_scope_tests {
    use super::*;
    #[test]
    fn folder_grants_are_per_window_and_must_be_directories() {
        let root = tempfile::tempdir().unwrap();
        let scopes = WorkspaceScopes::default();
        assert!(scopes.root("other").is_none());
        scopes.grant("one", root.path()).unwrap();
        assert!(scopes.root("one").unwrap().is_absolute());
        assert!(scopes.root("other").is_none());
        let file = root.path().join("a.md");
        std::fs::write(&file, "").unwrap();
        assert!(scopes.grant("other", &file).is_err());
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;
    #[test]
    fn searches_nested_utf8_disk_lines_with_exclusions_and_preserves_files() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("nested")).unwrap();
        std::fs::create_dir(root.path().join("vendor")).unwrap();
        let source = "front\r\n東京 needle\r\nNeedle is case sensitive\r\n";
        let file = root.path().join("nested/a.md");
        std::fs::write(&file, source).unwrap();
        for name in ["vendor/a.md", ".hidden.md", "image.png"] {
            std::fs::write(root.path().join(name), "needle").unwrap();
        }
        let result = search(root.path(), "needle", &["vendor".into()]).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].line, 2);
        assert_eq!(result.matches[0].preview, "東京 needle");
        assert_eq!(std::fs::read_to_string(file).unwrap(), source);
        assert!(!result.truncated);
        assert!(search(root.path(), "", &[]).is_err());
        assert!(search(root.path(), "a\nb", &[]).is_err());
        assert!(search(root.path(), &"x".repeat(257), &[]).is_err());
    }
    #[test]
    fn bounds_results_and_reports_unsupported_files() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.md"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
        std::fs::write(root.path().join("b.md"), [0xff]).unwrap();
        std::fs::write(root.path().join("c.md"), "東京 x\n".repeat(201)).unwrap();
        let result = search(root.path(), "x", &[]).unwrap();
        assert_eq!(result.skipped_files, 2);
        assert_eq!(result.matches.len(), 200);
        assert!(result.truncated);
    }
    #[cfg(unix)]
    #[test]
    fn search_omits_symlink_targets() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.md"), "needle").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("linked")).unwrap();
        assert!(search(root.path(), "needle", &[])
            .unwrap()
            .matches
            .is_empty());
    }
}
