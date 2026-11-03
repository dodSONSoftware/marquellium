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
    /// Application chrome scale in percent; document display is independent.
    #[serde(default = "ui_scale")]
    pub ui_scale: u32,
    #[serde(default = "ui_scale")]
    pub document_scale: u32,
    /// Default mode for freshly opened documents (FR-042). Starts as
    /// "source" until the M3V gate passes; user-overridable throughout.
    #[serde(default = "default_mode")]
    pub default_mode: String,
    /// Native spell-check (FR-049; platform support probed at M5).
    #[serde(default = "default_true")]
    pub spellcheck_enabled: bool,
    #[serde(default = "default_true")]
    pub show_frontmatter: bool,
    /// Sidebar state (FR-047).
    #[serde(default)]
    pub sidebar: SidebarSettings,
    #[serde(default = "reader_font")]
    pub reader_font: String,
    #[serde(default = "editor_font")]
    pub editor_font: String,
    #[serde(default = "font_size")]
    pub font_size: u32,
    #[serde(default = "editor_size")]
    pub editor_font_size: u32,
    #[serde(default = "spacing")]
    pub line_spacing: u32,
    #[serde(default = "max_width")]
    pub max_width: u32,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarSettings {
    #[serde(default = "default_visible")]
    pub visible: bool,
    #[serde(default = "default_width")]
    pub width: u32,
    /// "files" | "toc"
    #[serde(default = "default_section")]
    pub section: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Default for SidebarSettings {
    fn default() -> Self {
        Self {
            visible: default_visible(),
            width: default_width(),
            section: default_section(),
            extra: Default::default(),
        }
    }
}

fn ui_scale() -> u32 {
    100
}
fn reader_font() -> String {
    "system-ui".into()
}
fn editor_font() -> String {
    "ui-monospace".into()
}
fn font_size() -> u32 {
    16
}
fn editor_size() -> u32 {
    15
}
fn spacing() -> u32 {
    165
}
fn max_width() -> u32 {
    800
}
fn default_version() -> u32 {
    SETTINGS_VERSION
}
fn default_appearance() -> String {
    "system".into()
}
fn default_mode() -> String {
    "visual".into()
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
            ui_scale: ui_scale(),
            document_scale: ui_scale(),
            default_mode: default_mode(),
            spellcheck_enabled: true,
            show_frontmatter: true,
            sidebar: SidebarSettings::default(),
            reader_font: reader_font(),
            editor_font: editor_font(),
            font_size: font_size(),
            editor_font_size: editor_size(),
            line_spacing: spacing(),
            max_width: max_width(),
            extra: Default::default(),
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
        self.sidebar.width = self.sidebar.width.clamp(160, 500);
        if !["files", "toc"].contains(&self.sidebar.section.as_str()) {
            self.sidebar.section = default_section();
        }
        if !["system", "light", "dark"].contains(&self.appearance.as_str()) {
            self.appearance = default_appearance();
        }
        if !["read", "source", "split", "visual"].contains(&self.default_mode.as_str()) {
            self.default_mode = default_mode();
        }
        for (font, fallback) in [
            (&mut self.reader_font, reader_font()),
            (&mut self.editor_font, editor_font()),
        ] {
            if font.is_empty() || font.len() > 100 || font.chars().any(|c| c.is_control()) {
                *font = fallback;
            }
        }
        for scale in [&mut self.ui_scale, &mut self.document_scale] {
            *scale = if *scale == 0 {
                ui_scale()
            } else {
                (*scale).clamp(75, 200)
            };
        }
        self.font_size = self.font_size.clamp(12, 40);
        self.editor_font_size = self.editor_font_size.clamp(10, 32);
        self.line_spacing = self.line_spacing.clamp(100, 240);
        self.max_width = self.max_width.clamp(400, 1400);
        self
    }
}

pub struct SettingsStore {
    path: PathBuf,
    writer: std::sync::Mutex<()>,
}

impl SettingsStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            writer: std::sync::Mutex::new(()),
        }
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
        let _guard = self
            .writer
            .lock()
            .map_err(|_| std::io::Error::other("settings writer lock"))?;
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

#[cfg(test)]
mod m4_tests {
    use super::*;
    #[test]
    fn visual_is_fresh_default_without_overwriting_a_saved_source_preference() {
        assert_eq!(Settings::default().default_mode, "visual");
        assert_eq!(Settings::default().sidebar.width, 240);
        assert!(Settings::default().sidebar.visible);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"defaultMode":"source","showFrontmatter":false}"#).unwrap();
        let loaded = SettingsStore::new(path).load();
        assert_eq!(loaded.default_mode, "source");
        assert!(!loaded.show_frontmatter);
    }
}

#[cfg(test)]
mod m5_tests {
    use super::*;
    #[test]
    fn preserves_future_keys_and_normalizes_preferences_across_save_reload() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        std::fs::write(&path,r#"{"future":{"keep":true},"sidebar":{"future":42},"fontSize":900,"lineSpacing":0,"appearance":"invalid","defaultMode":"invalid"}"#).unwrap();
        let store = SettingsStore::new(path);
        let settings = store.load().normalized();
        assert_eq!(settings.font_size, 40);
        assert_eq!(settings.line_spacing, 100);
        assert_eq!(settings.appearance, "system");
        assert_eq!(settings.default_mode, "visual");
        store.save(&settings).unwrap();
        let reloaded = store.load();
        assert_eq!(reloaded.extra["future"], json!({"keep":true}));
        assert_eq!(reloaded.sidebar.extra["future"], 42);
    }
}

#[cfg(test)]
mod ui_scale_tests {
    use super::*;

    #[test]
    fn older_settings_default_to_normal_scale_and_round_trip_without_losing_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"appearance":"dark","future":{"keep":true}}"#).unwrap();
        let store = SettingsStore::new(path);
        let mut settings = store.load().normalized();
        assert_eq!(settings.ui_scale, 100);
        assert_eq!(settings.document_scale, 100);
        settings.ui_scale = 150;
        settings.document_scale = 125;
        store.save(&settings).unwrap();
        let reloaded = store.load().normalized();
        assert_eq!(reloaded.ui_scale, 150);
        assert_eq!(reloaded.document_scale, 125);
        assert_eq!(reloaded.appearance, "dark");
        assert_eq!(reloaded.extra["future"], json!({"keep":true}));
    }

    #[test]
    fn normalizes_scale_to_usable_bounds() {
        for (input, expected) in [
            (0, 100),
            (1, 75),
            (75, 75),
            (125, 125),
            (200, 200),
            (999, 200),
        ] {
            let settings = Settings {
                ui_scale: input,
                document_scale: input,
                ..Settings::default()
            }
            .normalized();
            assert_eq!(settings.ui_scale, expected);
            assert_eq!(settings.document_scale, expected);
        }
    }
}
