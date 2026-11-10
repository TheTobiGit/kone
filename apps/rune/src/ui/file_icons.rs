//! Electron's VS Code icon resolver and offline Iconify artwork.
//! Generated catalog is MIT licensed; see assets/licenses/vscode-icons.txt.
use rune::Icon;

#[path = "file_icons_data.rs"]
mod data;

fn lookup(table: &[(&str, usize)], key: &str) -> Option<usize> {
    table
        .binary_search_by_key(&key, |entry| entry.0)
        .ok()
        .map(|i| table[i].1)
}

fn named(name: &str) -> &'static Icon {
    &data::ICONS[data::NAMES.binary_search(&name).expect("catalog icon")]
}

pub(super) fn for_path(path: &str) -> &'static Icon {
    let base = path
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or(path);
    let base = base.rsplit_once(':').map_or(base, |(name, suffix)| {
        let mut parts = suffix.split('-');
        let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
        if parts.next().is_some_and(digits)
            && parts.next().is_none_or(digits)
            && parts.next().is_none()
        {
            name
        } else {
            base
        }
    });
    let lower = base.to_lowercase();
    let override_name = match lower.as_str() {
        "dockerfile" | ".dockerignore" => Some("file-type-docker"),
        "gemfile" | "gemfile.lock" => Some("file-type-bundler"),
        "cargo.toml" | "cargo.lock" => Some("file-type-cargo"),
        "bun.lock" | "bun.lockb" => Some("file-type-bun"),
        "poetry.lock" => Some("file-type-poetry"),
        "requirements.txt" => Some("file-type-pip"),
        "turbo.json" => Some("file-type-turbo"),
        "svelte.config.js" => Some("file-type-svelte"),
        "license" => Some("file-type-license"),
        _ if lower.starts_with(".env") => Some("file-type-dotenv"),
        _ => match lower.rsplit_once('.') {
            Some((prefix, "graphql" | "gql")) if !prefix.is_empty() => Some("file-type-graphql"),
            Some((prefix, "proto")) if !prefix.is_empty() => Some("file-type-protobuf"),
            _ => None,
        },
    };
    if let Some(name) = override_name {
        return named(name);
    }
    if let Some(index) = lookup(data::FILENAMES, base) {
        return &data::ICONS[index];
    }
    let mut parts = base.rsplit('.');
    let ext = parts.next().unwrap_or("");
    if let Some(previous) = parts.next() {
        if base.matches('.').count() >= 2 {
            let pair = format!("{previous}.{ext}");
            if let Some(index) = lookup(data::DOUBLE_EXTENSIONS, &pair) {
                return &data::ICONS[index];
            }
        }
    }
    if !ext.is_empty() {
        if let Some(index) = lookup(data::EXTENSIONS, ext).or_else(|| lookup(data::LANGUAGES, ext))
        {
            return &data::ICONS[index];
        }
    }
    named("default-file")
}

#[cfg(test)]
mod tests {
    use super::for_path;
    #[test]
    fn resolves_like_electron() {
        for (path, expected) in [
            ("src/Cargo.toml:12-14", "file-type-cargo"),
            (".env.production", "file-type-dotenv"),
            ("src/main.go:22", "file-type-go"),
            ("foo.test.tsx", "file-type-testts"),
            ("Dockerfile", "file-type-docker"),
            ("thing.unknown", "default-file"),
            ("logo.svg", "file-type-svg"),
        ] {
            assert_eq!(for_path(path).name, expected, "{path}");
        }
    }
}
