use serde::{Deserialize, Serialize};

/// App-level configuration. Stored as key-value in `meta.db` settings table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub appearance: Appearance,
    /// `"auto"` follows the OS locale detected via `tauri-plugin-os`;
    /// otherwise a BCP-47 tag like `"zh-CN"` or `"en"`.
    pub locale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    /// "light" | "dark" | "system"
    pub theme: String,
    /// "neutral" | "parchment"
    pub color_theme: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            appearance: Appearance {
                theme: "system".to_string(),
                color_theme: "neutral".to_string(),
            },
            locale: "auto".to_string(),
        }
    }
}
