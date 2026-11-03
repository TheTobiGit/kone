//! Local profile fallback and per-project lane preferences.

pub(super) fn identity() -> String {
    if let Ok(name) = std::env::var("KONE_PROFILE_NAME")
        && !name.trim().is_empty()
    {
        return name.trim().to_string();
    }
    // Same display-name transformation as Electron's useUser.ts.
    std::env::var("USER")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| {
            s.split(|c: char| c == '.' || c == '_' || c == '-' || c.is_whitespace())
                .filter(|s| !s.is_empty())
                .map(|part| {
                    let mut chars = part.chars();
                    chars
                        .next()
                        .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_else(|| "there".into())
}

fn fold_file() -> std::path::PathBuf {
    crate::projects::preferences_dir().join("overview-folds.json")
}
pub(super) fn load_folds(path: &str) -> [bool; 2] {
    std::fs::read(fold_file())
        .ok()
        .and_then(|b| {
            serde_json::from_slice::<std::collections::BTreeMap<String, [bool; 2]>>(&b).ok()
        })
        .and_then(|m| m.get(path).copied())
        .unwrap_or_default()
}
static FOLD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub(super) fn save_folds(path: &str, folded: [bool; 2]) {
    let _guard = FOLD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let file = fold_file();
    let mut map = std::fs::read(&file)
        .ok()
        .and_then(|b| {
            serde_json::from_slice::<std::collections::BTreeMap<String, [bool; 2]>>(&b).ok()
        })
        .unwrap_or_default();
    map.insert(path.into(), folded);
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(bytes) = serde_json::to_vec(&map) {
        let temp = file.with_extension("tmp");
        if std::fs::write(&temp, bytes).is_ok() {
            let _ = std::fs::rename(temp, file);
        }
    }
}
