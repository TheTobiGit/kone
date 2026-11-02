//! Reusable path expansion, collapse, and tab/inline autocomplete.
//!
//! Shared between `FolderPicker` (its address bar) and `CreateProject` (its
//! location input field). Pure matching logic is unit-tested without disk I/O.

use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use gpui_kit::base::input::InputState;
use gpui_kit::*;

pub const CHILD_CACHE_TTL: Duration = Duration::from_secs(10);

/// Resolved home directory, or `/` if $HOME is unset.
pub fn home_dir() -> PathBuf {
    env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// Expands a raw input string (e.g. `~/projects`) into an absolute path.
pub fn expand(home: &Path, raw: &str) -> PathBuf {
    let raw = raw.trim();
    if raw == "~" {
        return home.to_path_buf();
    }
    let path = if let Some(rest) = raw.strip_prefix("~/") {
        // `Path::join` with an absolute part replaces the base, so `~//tmp`
        // would land on `/tmp`; extra slashes after `~` stay under home.
        home.join(rest.trim_start_matches('/'))
    } else {
        PathBuf::from(raw)
    };
    let text = path.to_string_lossy();
    if text.len() <= 1 || !text.ends_with('/') {
        return path;
    }
    let trimmed = text.trim_end_matches('/');
    if trimmed.is_empty() {
        PathBuf::from("/")
    } else {
        PathBuf::from(trimmed)
    }
}

/// Collapses an absolute path into `~/…` if it lives under home.
pub fn collapse(home: &Path, path: &Path) -> String {
    if path == home {
        return "~/".into();
    }
    if let Ok(rest) = path.strip_prefix(home) {
        return format!("~/{}", rest.display());
    }
    path.display().to_string()
}

/// Whether an edit qualifies for inline forward completion.
///
/// A cut, backspace, middle-of-line edit, or paste-over must NOT complete, as
/// that would immediately put text back that the user just removed.
pub fn should_complete(value: &str, previous: &str, cursor: usize) -> bool {
    value.starts_with(previous) && value.len() > previous.len() && cursor == value.len()
}

/// Extracts the parent directory and trailing filename fragment to complete.
/// Returns None if the input ends with a slash or doesn't have an absolute parent.
pub fn split_path_fragment(home: &Path, value: &str) -> Option<(PathBuf, String)> {
    let frag = value.rsplit('/').next().filter(|f| !f.is_empty())?.to_string();
    let expanded = expand(home, value);
    let parent = expanded.parent().filter(|p| p.is_absolute())?.to_path_buf();
    Some((parent, frag))
}

/// Pure completion matching: searches `names` for the first entry whose name
/// starts with `frag` (case-insensitive) and is strictly longer.
///
/// Returns `(completed_text, selection_start, selection_end)`.
pub fn find_completion(base: &str, frag: &str, names: &[String]) -> Option<(String, usize, usize)> {
    let lower = frag.to_lowercase();
    let typed_chars = frag.chars().count();
    let name = names.iter().find(|name| {
        name.chars().count() > typed_chars && name.to_lowercase().starts_with(&lower)
    })?;

    // Matching ignores case, but the result takes the folder's real spelling:
    // `~/doc` must become `~/Documents`, which exists, not `~/documents`.
    let head = base.strip_suffix(frag).unwrap_or(base);
    let typed: String = name.chars().take(typed_chars).collect();
    let completed = format!("{head}{name}");
    let start = head.len() + typed.len();
    let end = completed.len();
    Some((completed, start, end))
}

/// Reads subdirectory names of `dir`, excluding hidden folders.
pub fn child_dir_names(dir: &Path) -> Option<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if entry_is_dir(&entry) {
            names.push(name);
        }
    }
    names.sort_by_cached_key(|name| name.to_lowercase());
    Some(names)
}

fn entry_is_dir(entry: &fs::DirEntry) -> bool {
    let Ok(file_type) = entry.file_type() else { return false };
    if file_type.is_dir() {
        true
    } else if file_type.is_symlink() {
        fs::metadata(entry.path()).is_ok_and(|meta| meta.is_dir())
    } else {
        false
    }
}

/// Reusable stateful path completer for input fields.
pub struct PathCompleter {
    pub home: PathBuf,
    pub last_input: String,
    pub child_cache: HashMap<PathBuf, (Vec<String>, Instant)>,
}

impl PathCompleter {
    pub fn new(home: PathBuf) -> Self {
        Self {
            home,
            last_input: String::new(),
            child_cache: HashMap::new(),
        }
    }

    pub fn set_text(&mut self, text: String) {
        self.last_input = text;
    }

    /// Collapses any active completion selection in the given input, accepting it.
    /// Returns true if a completion was active and accepted.
    pub fn accept_completion(
        &self,
        input: &Entity<InputState>,
        window: &Window,
        cx: &mut App,
    ) -> bool {
        if !input.read(cx).focus_handle(cx).is_focused(window) {
            return false;
        }
        let range = input.read(cx).selected_range();
        if range.is_empty() {
            return false;
        }
        let end = range.end;
        input.update(cx, |state, cx| state.set_selected_range(end..end, cx));
        true
    }

    /// Cleans expired entries from the child directory cache.
    pub fn prune_cache(&mut self) {
        self.child_cache.retain(|_, (_, at)| at.elapsed() < CHILD_CACHE_TTL);
    }
}

/// A view with a single path field completed by a [`PathCompleter`].
pub trait CompletesPath: 'static + Sized {
    fn completer(&mut self) -> &mut PathCompleter;
}

/// Runs inline completion for `input` after a change: on the way in only,
/// against the parent's children (cached for [`CHILD_CACHE_TTL`]).
pub fn complete_on_change<T: CompletesPath>(
    this: &mut T,
    input: &Entity<InputState>,
    window: &mut Window,
    cx: &mut Context<T>,
) {
    let value = input.read(cx).value().to_string();
    let cursor = input.read(cx).cursor();
    let completer = this.completer();
    let previous = std::mem::replace(&mut completer.last_input, value.clone());
    if !should_complete(&value, &previous, cursor) {
        return;
    }
    let Some((parent, frag)) = split_path_fragment(&completer.home, &value) else {
        return;
    };
    if let Some((names, at)) = completer.child_cache.get(&parent)
        && at.elapsed() < CHILD_CACHE_TTL
    {
        let names = names.clone();
        apply_completion(this, input, value, frag, names, window, cx);
        return;
    }
    let task = cx.background_spawn(async move {
        let names = child_dir_names(&parent);
        (parent, names)
    });
    let input = input.clone();
    cx.spawn_in(window, async move |view, cx| {
        let (parent, names) = task.await;
        let Some(names) = names else { return };
        view.update_in(cx, |this, window, cx| {
            let completer = this.completer();
            completer.prune_cache();
            completer.child_cache.insert(parent, (names.clone(), Instant::now()));
            apply_completion(this, &input, value, frag, names, window, cx);
        })
        .ok();
    })
    .detach();
}

/// Appends the first matching child and selects the appended part, but only
/// while the field still holds exactly the text the lookup started from.
fn apply_completion<T: CompletesPath>(
    this: &mut T,
    input: &Entity<InputState>,
    base: String,
    frag: String,
    names: Vec<String>,
    window: &mut Window,
    cx: &mut Context<T>,
) {
    if input.read(cx).value() != base || input.read(cx).cursor() != base.len() {
        return;
    }
    let Some((completed, start, end)) = find_completion(&base, &frag, &names) else {
        return;
    };
    this.completer().set_text(completed.clone());
    input.update(cx, |state, cx| {
        state.set_value(completed, window, cx);
        state.set_selected_range(start..end, cx);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::prelude::v1::test;

    #[test]
    fn test_expand_and_collapse() {
        let home = PathBuf::from("/home/user");
        assert_eq!(expand(&home, "~"), home);
        assert_eq!(expand(&home, "~/"), home);
        assert_eq!(expand(&home, "~/projects"), home.join("projects"));
        assert_eq!(expand(&home, "~/projects/"), home.join("projects"));
        assert_eq!(expand(&home, "/var/log"), PathBuf::from("/var/log"));
        assert_eq!(expand(&home, "/var/log/"), PathBuf::from("/var/log"));

        // Doubled slashes after the tilde stay under home.
        assert_eq!(expand(&home, "~//tmp/x"), home.join("tmp/x"));
        assert_eq!(expand(&home, "~///tmp/"), home.join("tmp"));
        assert_eq!(expand(&home, "~//"), home);
        assert_eq!(expand(&home, "  ~/a  "), home.join("a"));
        // `~user` isn't ours to expand; it stays literal.
        assert_eq!(expand(&home, "~other/x"), PathBuf::from("~other/x"));

        assert_eq!(collapse(&home, &home), "~/");
        assert_eq!(collapse(&home, &home.join("projects")), "~/projects");
        assert_eq!(collapse(&home, Path::new("/var/log")), "/var/log");
    }

    #[test]
    fn test_should_complete() {
        // Forward typing from the end: should complete
        assert!(should_complete("~/doc", "~/do", 5));

        // Backspace: shorter than previous
        assert!(!should_complete("~/do", "~/doc", 4));

        // Cursor in middle
        assert!(!should_complete("~/doc", "~/do", 3));

        // Completely replaced string
        assert!(!should_complete("/etc", "~/do", 4));

        // Identical length (cursor moved)
        assert!(!should_complete("~/do", "~/do", 4));
    }

    #[test]
    fn test_split_path_fragment() {
        let home = PathBuf::from("/home/user");
        let (parent, frag) = split_path_fragment(&home, "~/proj").expect("splits fragment");
        assert_eq!(parent, home);
        assert_eq!(frag, "proj");

        let (parent, frag) = split_path_fragment(&home, "/usr/loc").expect("splits fragment");
        assert_eq!(parent, PathBuf::from("/usr"));
        assert_eq!(frag, "loc");

        // Trailing slash has no trailing fragment
        assert_eq!(split_path_fragment(&home, "~/"), None);
        assert_eq!(split_path_fragment(&home, "/"), None);
        assert_eq!(split_path_fragment(&home, ""), None);
    }

    #[test]
    fn test_find_completion() {
        let names = vec![
            "Desktop".to_string(),
            "Documents".to_string(),
            "Downloads".to_string(),
            "Music".to_string(),
        ];

        // Prefix match
        let (completed, start, end) =
            find_completion("~/Doc", "Doc", &names).expect("completes Doc");
        assert_eq!(completed, "~/Documents");
        assert_eq!(start, 5);
        assert_eq!(end, 11);

        // Case-insensitive match
        let (completed, start, end) =
            find_completion("~/doc", "doc", &names).expect("case-insensitive complete");
        assert_eq!(completed, "~/Documents");
        assert_eq!(start, 5);
        assert_eq!(end, 11);

        // Already fully typed
        assert_eq!(find_completion("~/Documents", "Documents", &names), None);

        // No match
        assert_eq!(find_completion("~/Photos", "Photos", &names), None);
    }
}
