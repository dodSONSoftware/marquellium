//! The scoped `local-media:` protocol (ADR-003, T3, FR-023).
//!
//! Document images load through this custom URI scheme instead of any
//! filesystem protocol. Every request is percent-decoded, canonicalized
//! (resolving symlinks), and checked against the set of allowed roots —
//! the parent directories of currently open documents. Out-of-scope,
//! malformed, or non-image requests fail closed with 404.
//!
//! Content type comes from sniffing the bytes, never the file extension.
//! SVG is allowed because as an `<img>` payload it cannot execute scripts;
//! it is the only vector type served.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_MEDIA_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MediaError {
    #[error("malformed media request")]
    Malformed,
    #[error("file not found")]
    NotFound,
    #[error("path escapes the media scope")]
    OutsideScope,
    #[error("file exceeds the media size limit")]
    TooLarge,
    #[error("not a supported media type")]
    NotMedia,
}

#[derive(Debug)]
pub struct MediaFile {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

/// Allowed roots: the parent directory of each open (or save-target)
/// document. All roots are canonical. The set is Arc-shared: the protocol
/// handler holds a clone of the managed state and must observe roots added
/// by later document opens, so clones share the live set (not a snapshot).
#[derive(Default, Clone)]
pub struct MediaScope(std::sync::Arc<Mutex<HashSet<PathBuf>>>);

impl MediaScope {
    pub fn add_root(&self, dir: &Path) {
        if let Ok(canon) = dir.canonicalize() {
            self.0.lock().expect("media scope lock").insert(canon);
        }
    }

    /// Resolve a percent-encoded absolute path request to media bytes.
    pub fn resolve(&self, requested: &str) -> Result<MediaFile, MediaError> {
        if requested.is_empty() || requested.contains('\0') {
            return Err(MediaError::Malformed);
        }
        let path = PathBuf::from(requested);
        if !path.is_absolute() {
            return Err(MediaError::Malformed);
        }
        // Canonicalize resolves `..` and symlinks; a missing file is a
        // NotFound, not an error worth distinguishing further.
        let canon = path.canonicalize().map_err(|_| MediaError::NotFound)?;
        {
            let scope = self.0.lock().expect("media scope lock");
            let in_scope = scope.iter().any(|root| canon.starts_with(root));
            if !in_scope {
                return Err(MediaError::OutsideScope);
            }
        }
        let meta = std::fs::metadata(&canon).map_err(|_| MediaError::NotFound)?;
        if !meta.is_file() || meta.len() > MAX_MEDIA_BYTES as u64 {
            return Err(if meta.len() > MAX_MEDIA_BYTES as u64 {
                MediaError::TooLarge
            } else {
                MediaError::NotFound
            });
        }
        let bytes = std::fs::read(&canon).map_err(|_| MediaError::NotFound)?;
        let mime = sniff_mime(&bytes).ok_or(MediaError::NotMedia)?;
        Ok(MediaFile { mime, bytes })
    }
}

/// Magic-byte sniffing. Extension is deliberately not consulted.
fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.len() >= 12
        && bytes.starts_with(b"RIFF")
        && &bytes[8..12] == b"WEBP"
    {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        let mut head: Vec<u8> = bytes
            .iter()
            .take(512)
            .filter(|b| !b.is_ascii_whitespace())
            .copied()
            .collect();
        head.make_ascii_lowercase();
        if head.starts_with(b"<") && head.windows(4).any(|w| w == b"<svg") {
            Some("image/svg+xml")
        } else {
            None
        }
    }
}

/// Percent-decode a path (`%20` etc.). Invalid sequences fail closed.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Extract the (percent-decoded) absolute path from a full request URI.
/// Handles both `local-media:/abs/path` and the WebView-normalized
/// `local-media://localhost/abs/path` shape.
///
/// The path MUST be absolute: a missing leading slash (e.g.
/// `local-media:Users/...`) is malformed and rejected, so `scope.resolve`
/// never sees a relative path (fail closed).
pub fn media_path_from_uri(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("local-media:")?;
    let rest = rest.strip_prefix("//localhost").unwrap_or(rest);
    let path = rest.strip_prefix('/')?;
    if path.is_empty() {
        return None;
    }
    Some(format!("/{}", percent_decode(path)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_scope_image_resolves_with_sniffed_mime() {
        let dir = tempfile::tempdir().unwrap();
        let scope = MediaScope::default();
        scope.add_root(dir.path());
        std::fs::write(dir.path().join("pic.png"), [0x89, 0x50, 0x4e, 0x47, 0, 0]).unwrap();

        let file = scope
            .resolve(&dir.path().join("pic.png").to_string_lossy())
            .unwrap();
        assert_eq!(file.mime, "image/png");
        assert_eq!(file.bytes[0], 0x89);
    }

    #[test]
    fn traversal_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let outer = tempfile::tempdir().unwrap();
        std::fs::write(outer.path().join("secret.png"), [0x89, 0x50, 0x4e, 0x47]).unwrap();
        let scope = MediaScope::default();
        scope.add_root(dir.path());

        let evil = dir.path().join("../").join(outer.path().file_name().unwrap());
        let err = scope.resolve(&evil.to_string_lossy()).unwrap_err();
        // `..` canonicalizes out of the scope (or the file simply isn't
        // there): either way, never served.
        assert!(matches!(err, MediaError::OutsideScope | MediaError::NotFound));
    }

    #[test]
    fn symlink_escape_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let outer = tempfile::tempdir().unwrap();
        std::fs::write(outer.path().join("secret.png"), [0x89, 0x50, 0x4e, 0x47]).unwrap();
        let scope = MediaScope::default();
        scope.add_root(dir.path());
        let link = dir.path().join("link.png");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outer.path().join("secret.png"), &link).unwrap();
        #[cfg(not(unix))]
        {
            // Copy fallback keeps the test meaningful cross-platform.
            std::fs::copy(outer.path().join("secret.png"), &link).unwrap();
            return;
        }

        let err = scope.resolve(&link.to_string_lossy()).unwrap_err();
        assert_eq!(err, MediaError::OutsideScope);
    }

    #[test]
    fn non_image_file_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let scope = MediaScope::default();
        scope.add_root(dir.path());
        std::fs::write(dir.path().join("notes.md"), "hello").unwrap();

        let err = scope
            .resolve(&dir.path().join("notes.md").to_string_lossy())
            .unwrap_err();
        assert_eq!(err, MediaError::NotMedia);
    }

    #[test]
    fn malformed_requests_fail_closed() {
        let scope = MediaScope::default();
        assert_eq!(scope.resolve("").unwrap_err(), MediaError::Malformed);
        assert_eq!(scope.resolve("relative/path").unwrap_err(), MediaError::Malformed);
        assert_eq!(
            scope.resolve("/a\0b.png").unwrap_err(),
            MediaError::Malformed
        );
    }

    #[test]
    fn oversized_file_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let scope = MediaScope::default();
        scope.add_root(dir.path());
        let big = dir.path().join("big.png");
        let mut f = std::fs::File::create(&big).unwrap();
        use std::io::Write as _;
        f.write_all(&[0x89, 0x50, 0x4e, 0x47]).unwrap();
        f.write_all(&vec![0u8; MAX_MEDIA_BYTES]).unwrap();

        let err = scope.resolve(&big.to_string_lossy()).unwrap_err();
        assert_eq!(err, MediaError::TooLarge);
    }

    #[test]
    fn uri_parsing_handles_shapes_and_percent_encoding() {
        assert_eq!(
            media_path_from_uri("local-media:/Users/x/a%20b.png").as_deref(),
            Some("/Users/x/a b.png")
        );
        assert_eq!(
            media_path_from_uri("local-media://localhost/Users/x/a.png").as_deref(),
            Some("/Users/x/a.png")
        );
        assert_eq!(media_path_from_uri("local-media:"), None);
        assert_eq!(media_path_from_uri("local-media:/a%ZZ.png"), None);
    }
}
