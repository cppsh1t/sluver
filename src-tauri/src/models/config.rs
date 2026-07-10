use serde::{Deserialize, Serialize};

/// App-level configuration. Stored as key-value in `meta.db` settings table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub appearance: Appearance,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    /// "light" | "dark" | "system"
    pub theme: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            appearance: Appearance {
                theme: "system".to_string(),
            },
        }
    }
}
