//! The projects the user has opened, most recent first.
//!
//! Electron keeps this list in its renderer's localStorage under
//! `kone:recent-projects` (`useRecentProjects.ts`), which a native process
//! can't read. Until agent-core serves `recents.list` over JSON-RPC, the native
//! shell keeps the same records — same fields, same 24-entry cap, same
//! dedupe-on-path and pin carry-over — in a JSON file in the app's data folder.

use std::{
    env, fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use kone_rpc::Branch;
use serde::{Deserialize, Serialize};

const MAX: usize = 24;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub last_opened_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
}

/// What the project view shows, read from disk when the project opens.
#[derive(Clone, Debug)]
pub struct OpenProject {
    pub name: String,
    pub path: PathBuf,
    pub branch: Option<Branch>,
    pub added: u32,
    pub removed: u32,
}

/// `~/Library/Application Support/kone` on macOS, `$XDG_DATA_HOME/kone`
/// (default `~/.local/share/kone`) elsewhere.
fn data_dir() -> PathBuf {
    let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"));
    if cfg!(target_os = "macos") {
        return home.join("Library/Application Support/kone");
    }
    match env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir).join("kone"),
        None => home.join(".local/share/kone"),
    }
}

fn store_path() -> PathBuf {
    data_dir().join("recent-projects.json")
}

pub fn load() -> Vec<RecentProject> {
    fs::read_to_string(store_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(list: &[RecentProject]) -> io::Result<()> {
    let path = store_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(list).map_err(io::Error::other)?)?;
    fs::rename(tmp, path)
}

/// Records (or bumps) a project as just opened, keeping its pin.
pub fn remember(path: &Path, name: &str) -> io::Result<()> {
    let key = path.to_string_lossy().into_owned();
    let mut list = load();
    let pinned = list.iter().find(|p| p.path == key).and_then(|p| p.pinned);
    list.retain(|p| p.path != key);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    list.insert(0, RecentProject { path: key, name: name.to_string(), last_opened_at: now, pinned });
    list.truncate(MAX);
    save(&list)
}

/// Validates the folder, records it, and reads what the project view shows.
/// Blocking: call it off the UI thread.
pub fn open(path: &Path) -> Result<OpenProject, String> {
    let path = fs::canonicalize(path).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => "That folder no longer exists.".to_string(),
        io::ErrorKind::PermissionDenied => "You don't have permission to open that folder.".to_string(),
        _ => format!("Couldn't open that folder: {e}"),
    })?;
    if !path.is_dir() {
        return Err("That's a file, not a folder.".into());
    }
    fs::read_dir(&path).map_err(|_| "You don't have permission to read that folder.".to_string())?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let summary = crate::folder_picker::repo_summary(&path);
    remember(&path, &name).map_err(|e| format!("Couldn't save the project list: {e}"))?;
    Ok(OpenProject {
        name,
        branch: summary.as_ref().map(|s| s.branch.clone()),
        added: summary.as_ref().map_or(0, |s| s.added),
        removed: summary.as_ref().map_or(0, |s| s.removed),
        path,
    })
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RepoVisibility {
    #[default]
    Private,
    Public,
}

/// What the create modal asks for. Mirrors Electron's `CreateProjectOptions`
/// (`git-core/types.ts`) minus the GitHub remote and setup command.
#[derive(Clone, Debug)]
pub struct CreateOptions {
    pub parent: PathBuf,
    pub name: String,
    pub git: bool,
    pub readme: bool,
    pub branch: String,
}

/// A single, safe path segment, the same rule as Electron's `isSafeSegment`.
pub fn valid_name(name: &str) -> bool {
    let name = name.trim();
    !(name.is_empty() || name == "." || name == "..") && !name.contains(['/', '\\', '\0'])
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => "Git isn't installed, so the folder was created without a repository.".to_string(),
            _ => format!("Couldn't run git: {e}"),
        })?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("git failed");
        Err(line.trim().to_string())
    }
}

/// Lays a fresh project folder on disk the way Electron's `git/create.ts`
/// does: refuse an unsafe name or an existing target, mkdir, seed README.md,
/// `git init -b <branch>`, stage, and land an initial commit when a git
/// identity is configured. Blocking: call it off the UI thread.
pub fn create(opts: &CreateOptions) -> Result<PathBuf, String> {
    let name = opts.name.trim();
    if !valid_name(name) {
        return Err(format!("\u{201c}{name}\u{201d} isn't a valid folder name."));
    }
    match fs::metadata(&opts.parent) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err("The location is a file, not a folder.".into()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Err("The location doesn't exist.".into()),
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
            return Err("You don't have permission to use that location.".into())
        }
        Err(e) => return Err(format!("Couldn't read the location: {e}")),
    }
    let target = opts.parent.join(name);
    if fs::symlink_metadata(&target).is_ok() {
        return Err(format!("A folder already exists at {}", target.display()));
    }
    fs::create_dir(&target).map_err(|e| match e.kind() {
        io::ErrorKind::PermissionDenied => "You don't have permission to create a folder there.".to_string(),
        io::ErrorKind::AlreadyExists => format!("A folder already exists at {}", target.display()),
        _ => format!("Couldn't create the folder: {e}"),
    })?;
    if opts.git && opts.readme {
        fs::write(target.join("README.md"), format!("# {name}\n"))
            .map_err(|e| format!("Couldn't write README.md: {e}"))?;
    }
    if opts.git {
        let branch = match opts.branch.trim() {
            "" => "main",
            b => b,
        };
        // Older git lacks `-b`; init plain and point HEAD at the branch.
        if git(&target, &["init", "-b", branch]).is_err() {
            git(&target, &["init"])?;
            git(&target, &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")])?;
        }
        // A failed stage or commit doesn't sink the create: the repo exists.
        let identity = git(&target, &["config", "user.email"]).is_ok_and(|e| !e.trim().is_empty());
        if git(&target, &["add", "-A"]).is_ok() && identity {
            let _ = git(&target, &["commit", "-m", "Initial commit", "--allow-empty"]);
        }
    }
    Ok(target)
}
