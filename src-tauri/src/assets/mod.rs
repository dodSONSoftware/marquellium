//! Explicit clipboard import into a single adjacent asset directory. No overwrite.
use std::{
    fs::OpenOptions,
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_RGBA_BYTES: usize = 32 * 1024 * 1024;

pub fn persist_rgba(
    document: &Path,
    folder: &str,
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<String, String> {
    if folder.is_empty()
        || folder == "."
        || folder == ".."
        || folder
            .chars()
            .any(|c| matches!(c, '/' | '\\' | '\0' | ':') || c.is_control())
    {
        return Err("Choose a single adjacent assets folder name".into());
    }
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or("Image dimensions overflow")?;
    if width == 0 || height == 0 || expected != rgba.len() || expected > MAX_RGBA_BYTES {
        return Err("Image exceeds the 32 MiB RGBA limit or has invalid dimensions".into());
    }
    let document = document.canonicalize().map_err(|e| e.to_string())?;
    let parent = document
        .parent()
        .ok_or("Save the document before pasting images")?;
    let directory = parent.join(folder);
    if directory.exists()
        && std::fs::symlink_metadata(&directory)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err("Asset directory cannot be a symlink".into());
    }
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let directory =
        crate::workspace::resolve_in_scope(parent, &directory).map_err(|e| e.to_string())?;
    let mut encoded = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut encoded, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .map_err(|e| e.to_string())?
            .write_image_data(rgba)
            .map_err(|e| e.to_string())?;
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    for serial in 0..100 {
        let name = format!("image-{stamp}-{serial}.png");
        let path = directory.join(&name);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        };
        if let Err(error) = file.write_all(&encoded).and_then(|()| file.sync_all()) {
            let _ = std::fs::remove_file(&path);
            return Err(error.to_string());
        }
        let escaped = folder
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect::<String>();
        return Ok(format!("{escaped}/{name}"));
    }
    Err("Could not allocate a unique image name".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_import_is_unique_encoded_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("note.md");
        std::fs::write(&doc, "original").unwrap();
        let a = persist_rgba(&doc, "my assets", 1, 1, &[1, 2, 3, 255]).unwrap();
        let b = persist_rgba(&doc, "my assets", 1, 1, &[1, 2, 3, 255]).unwrap();
        assert_ne!(a, b);
        assert!(a.starts_with("my%20assets/"));
        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "original");
        let bytes = std::fs::read(dir.path().join(a.replace("%20", " "))).unwrap();
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        for bad in ["../outside", "/tmp", ".", "..", "a\\b", "a\0b"] {
            assert!(persist_rgba(&doc, bad, 1, 1, &[0; 4]).is_err());
        }
        assert!(persist_rgba(&doc, "assets", u32::MAX, u32::MAX, &[]).is_err());
        assert!(persist_rgba(&doc, "assets", 1, 1, &[]).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_asset_directory() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let doc = dir.path().join("a.md");
        std::fs::write(&doc, "").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("assets")).unwrap();
        assert!(persist_rgba(&doc, "assets", 1, 1, &[0; 4]).is_err());
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    }
}
