//! SettingsService (ADR-004): schema-versioned JSON in the app-data
//! directory. Unknown keys are preserved across migrations (FR-034).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const SETTINGS_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Schema version. Loaders run migrations from this.
    #[serde(default = "default_version")]
    pub schema_version: u32,
    /// Appearance: "light" | "dark" | "system".
    #[serde(default = "default_appearance")]
    pub appearance: String,
    /// Default mode for freshly opened documents (FR-042). Starts as
    /// "source" until the M3V gate passes; user-overridable throughout.
    #[serde(default = "default_mode")]
    pub default_mode: String,
    /// Native spell-check (FR-049; platform support probed at M5).
    #[serde(default = "default_true")]
    pub spellcheck_enabled: bool,
    /// Sidebar state (FR-047).
    #[serde(default)]
    pub sidebar: SidebarSettings,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarSettings {
    #[serde(default = "default_visible")]
    pub visible: bool,
    #[serde(default = "default_width")]
    pub width: u32,
    /// "files" | "toc"
    #[serde(default = "default_section")]
    pub section: String,
}

fn default_version() -> u32 {
    SETTINGS_VERSION
}
fn default_appearance() -> String {
    "system".into()
}
fn default_mode() -> String {
    "source".into()
}
fn default_true() -> bool {
    true
}
fn default_visible() -> bool {
    true
}
fn default_width() -> u32 {
    240
}
fn default_section() -> String {
    "files".into()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_VERSION,
            appearance: default_appearance(),
            default_mode: default_mode(),
            spellcheck_enabled: true,
            sidebar: SidebarSettings::default(),
        }
    }
}

impl Settings {
    /// Normalize user-settable fields that could arrive zeroed or empty
    /// (a partial or stale payload). A persisted sidebar width of 0 would
    /// render an unusable panel; an empty section has no UI surface.
    pub fn normalized(mut self) -> Self {
        if self.sidebar.width == 0 {
            self.sidebar.width = SidebarSettings::default().width;
        }
        if self.sidebar.section.is_empty() {
            self.sidebar.section = default_section();
        }
        self
    }
}

pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Load, running migrations. A missing file yields defaults. Corrupt
    /// files are quarantined (renamed `.corrupt`) rather than destroyed, and
    /// defaults are returned (fail safe, never silent data loss).
    pub fn load(&self) -> Settings {
        let Ok(raw) = std::fs::read(&self.path) else {
            return Settings::default();
        };
        let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(&raw) else {
            let quarantine = self.path.with_extension("json.corrupt");
            let _ = std::fs::rename(&self.path, quarantine);
            return Settings::default();
        };

        let from_version = map
            .get("schemaVersion")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;

        // Migrations run in order. v0 → v1: no fields existed yet; nothing
        // to migrate, but the hook is here for the future.
        let mut version = from_version;
        if version < 1 {
            version = 1;
        }

        // Preserve unknown keys: merge defaults under the parsed object so
        // future fields fill in without dropping user data.
        let mut defaults = serde_json::to_value(Settings::default()).unwrap_or_else(|_| json!({}));
        if let Some(d) = defaults.as_object_mut() {
            for (k, v) in map.iter() {
                d.insert(k.clone(), v.clone());
            }
        }
        if let Some(d) = defaults.as_object_mut() {
            d.insert("schemaVersion".into(), json!(version));
        }
        serde_json::from_value(defaults).unwrap_or_default()
    }

    /// Atomic write (temp + rename).
    pub fn save(&self, settings: &Settings) -> std::result::Result<(), std::io::Error> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(settings).unwrap())?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_repairs_zeroed_sidebar_fields() {
        let broken: Settings = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "appearance": "dark",
            "sidebar": { "visible": true, "width": 0, "section": "" }
        }))
        .unwrap();
        let fixed = broken.normalized();
        assert_eq!(fixed.sidebar.width, SidebarSettings::default().width);
        assert_eq!(fixed.sidebar.section, "files");
    }

    #[test]
    fn normalized_preserves_valid_values() {
        let s: Settings = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "sidebar": { "visible": false, "width": 320, "section": "toc" }
        }))
        .unwrap();
        let fixed = s.normalized();
        assert_eq!(fixed.sidebar.width, 320);
        assert_eq!(fixed.sidebar.section, "toc");
        assert!(!fixed.sidebar.visible);
    }

    #[test]
    fn load_quarantines_corrupt_file_and_returns_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"not json {").unwrap();

        let store = SettingsStore::new(&path);
        let s = store.load();
        assert_eq!(s, Settings::default());
        assert!(path.with_extension("json.corrupt").exists());
    }
}
