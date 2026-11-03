//! Session state (FR-033, FR-004): open tabs and recent-file history, kept
//! as schema-versioned JSON in the app-data directory (ADR-004).
//!
//! Restoration contract:
//!  - a tab stores only its file path and its selected mode — never content.
//!    Unsaved content is covered by the crash-recovery snapshots (FR-006),
//!    which are surfaced separately and never merged over a file;
//!  - recent entries are paths only, most-recent-first, capped, and de-
//!    duplicated; the shell omits unavailable files gracefully (FR-004).

use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SESSION_VERSION: u32 = 1;
pub const MAX_RECENT: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    #[serde(default = "default_version")]
    pub schema_version: u32,
    /// File-backed tabs, in tab order.
    #[serde(default)]
    pub tabs: Vec<SessionTab>,
    /// Index into `tabs` of the active tab (clamped on load).
    #[serde(default)]
    pub active_index: u32,
    /// Recent file paths, most recent first.
    #[serde(default)]
    pub recent_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    /// Absolute path of the file (untitled documents are not session tabs —
    /// their content lives in recovery snapshots).
    pub path: String,
    /// Mode this tab was showing: "read" | "source" | "split" | "visual".
    #[serde(default = "default_mode")]
    pub mode: String,
}

fn default_version() -> u32 {
    SESSION_VERSION
}
fn default_mode() -> String {
    "source".into()
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            schema_version: SESSION_VERSION,
            tabs: Vec::new(),
            active_index: 0,
            recent_files: Vec::new(),
        }
    }
}

impl SessionState {
    /// Repair a payload that could arrive malformed (a truncated write, an
    /// out-of-range index, duplicate recents). Idempotent.
    pub fn normalized(mut self) -> Self {
        // Drop empty-path tabs: they have no file to restore.
        self.tabs.retain(|t| !t.path.trim().is_empty());
        if self.tabs.is_empty() {
            self.active_index = 0;
        } else {
            self.active_index = self.active_index.min((self.tabs.len() - 1) as u32);
        }
        // Recents: most-recent-first, de-duplicated (first wins), capped.
        // (HashSet<String> avoids borrowing from the vec while retaining.)
        let mut seen: HashSet<String> = HashSet::new();
        self.recent_files
            .retain(|p| !p.trim().is_empty() && seen.insert(p.clone()));
        self.recent_files.truncate(MAX_RECENT);
        self
    }
}

pub struct SessionStore {
    path: PathBuf,
}

impl SessionStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// A missing file yields an empty session. Corrupt files are
    /// quarantined (`.corrupt`) and an empty session returned — fail safe.
    pub fn load(&self) -> SessionState {
        let Ok(raw) = std::fs::read(&self.path) else {
            return SessionState::default();
        };
        let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(&raw) else {
            let quarantine = self.path.with_extension("json.corrupt");
            let _ = std::fs::rename(&self.path, quarantine);
            return SessionState::default();
        };
        // Merge over defaults so unknown/added fields fill in and the
        // version is recorded, mirroring SettingsStore::load.
        let mut defaults = serde_json::to_value(SessionState::default())
            .unwrap_or_else(|_| Value::Object(Default::default()));
        if let Some(d) = defaults.as_object_mut() {
            for (k, v) in map.iter() {
                d.insert(k.clone(), v.clone());
            }
            d.insert("schemaVersion".into(), serde_json::json!(SESSION_VERSION));
        }
        serde_json::from_value::<SessionState>(defaults)
            .unwrap_or_default()
            .normalized()
    }

    /// Atomic write (temp + rename).
    pub fn save(&self, state: &SessionState) -> std::result::Result<(), std::io::Error> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(state).unwrap())?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_clamps_active_index() {
        let s: SessionState = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "tabs": [ { "path": "/a.md" }, { "path": "/b.md" } ],
            "activeIndex": 99
        }))
        .unwrap();
        let n = s.normalized();
        assert_eq!(n.active_index, 1);
    }

    #[test]
    fn normalized_zeroes_index_when_no_tabs() {
        let s = SessionState {
            active_index: 5,
            ..Default::default()
        };
        assert_eq!(s.normalized().active_index, 0);
    }

    #[test]
    fn normalized_drops_empty_path_tabs() {
        let s: SessionState = serde_json::from_value(serde_json::json!({
            "tabs": [ { "path": "/a.md" }, { "path": "  " } ]
        }))
        .unwrap();
        let n = s.normalized();
        assert_eq!(n.tabs.len(), 1);
        assert_eq!(n.tabs[0].path, "/a.md");
    }

    #[test]
    fn normalized_dedupes_and_caps_recents() {
        let mut s = SessionState {
            recent_files: vec![
                "/a.md".into(),
                "/b.md".into(),
                "/a.md".into(), // duplicate — first occurrence wins
            ],
            ..Default::default()
        };
        for i in 0..15 {
            s.recent_files.push(format!("/c{i}.md"));
        }
        let n = s.normalized();
        assert_eq!(n.recent_files.len(), MAX_RECENT);
        assert_eq!(n.recent_files[0], "/a.md");
        // De-duplicated: each path appears at most once.
        let unique: HashSet<&String> = n.recent_files.iter().collect();
        assert_eq!(unique.len(), n.recent_files.len());
    }

    #[test]
    fn load_quarantines_corrupt_file_and_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        std::fs::write(&path, b"not json {").unwrap();

        let store = SessionStore::new(&path);
        let s = store.load();
        assert_eq!(s, SessionState::default());
        assert!(path.with_extension("json.corrupt").exists());
    }

    #[test]
    fn save_load_roundtrip_preserves_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        let store = SessionStore::new(&path);
        let s = SessionState {
            tabs: vec![SessionTab {
                path: "/x.md".into(),
                mode: "split".into(),
            }],
            active_index: 0,
            recent_files: vec!["/x.md".into(), "/y.md".into()],
            ..Default::default()
        };
        store.save(&s).unwrap();
        let loaded = store.load();
        assert_eq!(loaded, s.normalized());
        assert_eq!(loaded.tabs[0].mode, "split");
    }

    #[test]
    fn missing_file_yields_default() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path().join("nope.json"));
        assert_eq!(store.load(), SessionState::default());
    }
}
