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
    // A per-writer temp name, so two saves racing can't clobber one file.
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let tmp = path.with_extension(format!("json.{}.{nanos}.tmp", std::process::id()));
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
    // A folder inside a repo still belongs to it, as git-core's status()
    // resolves the top level: read the nearest ancestor that holds `.git`.
    let summary = path.ancestors().find_map(crate::folder_picker::repo_summary);
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
    pub remote: bool,
    pub repo_name: Option<String>,
    pub visibility: RepoVisibility,
    pub command: Option<String>,
}

/// A single, safe path segment, the same rule as Electron's `isSafeSegment`.
pub fn valid_name(name: &str) -> bool {
    let name = name.trim();
    !(name.is_empty() || name == "." || name == "..") && !name.contains(['/', '\\', '\0'])
}

/// The last non-empty line of a command's stderr, or `fallback` when blank.
pub fn last_stderr_line(stderr: &str, fallback: &str) -> String {
    stderr
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
        .unwrap_or_else(|| fallback.to_string())
}

/// Runs a user-supplied setup command inside the new project folder.
/// Runs through the shell (`sh -c` on Unix, `cmd /C` on Windows) with
/// GIT_TERMINAL_PROMPT=0 so prompts never hang.
pub fn run_setup_command(cwd: &Path, command: &str) -> Result<(), String> {
    #[cfg(unix)]
    let mut cmd = std::process::Command::new("sh");
    #[cfg(unix)]
    cmd.args(["-c", command]);

    #[cfg(windows)]
    let mut cmd = std::process::Command::new("cmd");
    #[cfg(windows)]
    cmd.args(["/C", command]);

    cmd.current_dir(cwd);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GCM_INTERACTIVE", "never");
    cmd.env("GIT_ASKPASS", "");
    cmd.env("LC_ALL", "C");
    // A scaffolder that prompts would otherwise wait forever on our stdin.
    cmd.stdin(std::process::Stdio::null());

    let output = cmd.output().map_err(|e| format!("Failed to run setup command: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let code = output.status.code().unwrap_or(1);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let fallback = format!("Command exited with code {code}");
        Err(last_stderr_line(&stderr, &fallback))
    }
}

/// Resolve the final GitHub repository name from an optional custom name and project name.
pub fn resolve_repo_name<'a>(custom: Option<&'a str>, project_name: &'a str) -> &'a str {
    match custom.map(str::trim) {
        Some(s) if !s.is_empty() => s,
        _ => project_name.trim(),
    }
}

/// Builds arguments for `gh repo create`.
pub fn build_gh_repo_create_args(repo_name: &str, visibility: RepoVisibility) -> Vec<String> {
    vec![
        "repo".into(),
        "create".into(),
        repo_name.into(),
        match visibility {
            RepoVisibility::Public => "--public".into(),
            RepoVisibility::Private => "--private".into(),
        },
        "--source=.".into(),
        "--remote=origin".into(),
        "--push".into(),
    ]
}

const GH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// `Command::output` with a deadline: past it the child is killed and the
/// second value is true. Stdin is closed so nothing waits on a prompt.
fn output_with_timeout(
    cmd: &mut std::process::Command,
    limit: std::time::Duration,
) -> io::Result<(std::process::Output, bool)> {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = cmd.spawn()?;
    let pid = child.id();
    let done = Arc::new(AtomicBool::new(false));
    let fired = Arc::new(AtomicBool::new(false));
    {
        let (done, fired) = (done.clone(), fired.clone());
        std::thread::spawn(move || {
            let start = std::time::Instant::now();
            while start.elapsed() < limit {
                if done.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            if !done.load(Ordering::SeqCst) {
                fired.store(true, Ordering::SeqCst);
                #[cfg(unix)]
                let _ = std::process::Command::new("kill").args(["-KILL", &pid.to_string()]).output();
                #[cfg(not(unix))]
                let _ = std::process::Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).output();
            }
        });
    }
    let out = child.wait_with_output();
    done.store(true, Ordering::SeqCst);
    out.map(|o| (o, fired.load(Ordering::SeqCst)))
}

/// Creates a GitHub repository via `gh repo create` and pushes the initial branch.
pub fn create_remote(target: &Path, repo_name: &str, visibility: RepoVisibility) -> Result<(), String> {
    let args = build_gh_repo_create_args(repo_name, visibility);
    let mut cmd = std::process::Command::new("gh");
    cmd.args(&args);
    cmd.current_dir(target);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GCM_INTERACTIVE", "never");
    cmd.env("GIT_ASKPASS", "");
    cmd.env("LC_ALL", "C");

    // Electron's createRemote gives gh 60 s; a hung network call must not
    // wedge the modal in its busy state forever.
    let (output, timed_out) = output_with_timeout(&mut cmd, GH_TIMEOUT).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => "GitHub CLI (gh) not found — install it to create a remote repo".to_string(),
        _ => format!("Couldn't run gh: {e}"),
    })?;
    if timed_out {
        return Err("Creating the GitHub repository timed out.".into());
    }

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let fallback = "Couldn’t create the GitHub repository";
        let line = last_stderr_line(&stderr, fallback);
        let line = line.strip_prefix("error: ").unwrap_or(&line).trim();
        Err(line.to_string())
    }
}

/// Checks `gh auth status` exit code in the background.
/// Note: Never prints or logs stdout/stderr tokens.
pub fn check_gh_auth_status() -> bool {
    let mut cmd = std::process::Command::new("gh");
    cmd.args(["auth", "status"]);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GCM_INTERACTIVE", "never");
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    cmd.status().is_ok_and(|s| s.success())
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("LC_ALL", "C")
        .stdin(std::process::Stdio::null())
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

    // From here on the folder is ours (create_dir just made it), so a failed
    // step removes it again; a retry then doesn't hit "already exists".
    match populate(opts, name, &target) {
        Ok(()) => Ok(target),
        Err(message) => {
            discard_created(&target);
            Err(message)
        }
    }
}

/// Removes a folder `create` made in this attempt. Never called for a folder
/// that existed beforehand; `remove_dir_all` doesn't follow symlinks out.
fn discard_created(target: &Path) {
    let _ = fs::remove_dir_all(target);
}

fn populate(opts: &CreateOptions, name: &str, target: &Path) -> Result<(), String> {
    // A setup command runs first, on the still-empty folder — scaffolders expect that.
    if let Some(cmd) = opts.command.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        run_setup_command(target, cmd)?;
    }

    let init_git = opts.git || opts.remote;
    // Seed README.md only if it does not already exist (a setup command might have created it)
    if init_git && opts.readme && !target.join("README.md").exists() {
        fs::write(target.join("README.md"), format!("# {name}\n"))
            .map_err(|e| format!("Couldn't write README.md: {e}"))?;
    }
    // A setup command might have already initialized git; only init when it didn't.
    if init_git && !target.join(".git").exists() {
        let branch = match opts.branch.trim() {
            "" => "main",
            b => b,
        };
        // Older git lacks `-b`; init plain and point HEAD at the branch.
        if git(target, &["init", "-b", branch]).is_err() {
            git(target, &["init"])?;
            git(target, &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")])?;
        }
        // A failed stage or commit doesn't sink the create: the repo exists.
        let identity = git(target, &["config", "user.email"]).is_ok_and(|e| !e.trim().is_empty());
        if git(target, &["add", "-A"]).is_ok() && identity {
            let _ = git(target, &["commit", "-m", "Initial commit", "--allow-empty"]);
        }
    }

    if opts.remote {
        let repo_name = resolve_repo_name(opts.repo_name.as_deref(), name);
        create_remote(target, repo_name, opts.visibility)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::prelude::v1::test;

    fn scratch(tag: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("kone-create-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn opts(parent: &Path, name: &str, command: Option<&str>) -> CreateOptions {
        CreateOptions {
            parent: parent.to_path_buf(),
            name: name.into(),
            git: false,
            readme: false,
            branch: "main".into(),
            remote: false,
            repo_name: None,
            visibility: RepoVisibility::Private,
            command: command.map(Into::into),
        }
    }

    #[test]
    fn failed_create_removes_the_folder_it_made() {
        let parent = scratch("fail");
        let err = create(&opts(&parent, "app", Some("touch made && exit 3"))).unwrap_err();
        assert!(!err.is_empty());
        assert!(!parent.join("app").exists(), "half-made folder left behind");
        assert!(parent.exists(), "parent must survive");
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn create_never_touches_an_existing_folder() {
        let parent = scratch("exists");
        fs::create_dir(parent.join("app")).unwrap();
        fs::write(parent.join("app/keep.txt"), "mine").unwrap();
        assert!(create(&opts(&parent, "app", None)).is_err());
        assert_eq!(fs::read_to_string(parent.join("app/keep.txt")).unwrap(), "mine");
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn successful_create_keeps_the_folder() {
        let parent = scratch("ok");
        let made = create(&opts(&parent, "app", Some("touch made"))).unwrap();
        assert!(made.join("made").exists());
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn test_valid_name() {
        assert!(valid_name("my-app"));
        assert!(valid_name("app_1.0"));
        assert!(!valid_name(""));
        assert!(!valid_name("   "));
        assert!(!valid_name("."));
        assert!(!valid_name(".."));
        assert!(!valid_name("foo/bar"));
        assert!(!valid_name("foo\\bar"));
        assert!(!valid_name("foo\0bar"));
    }

    #[test]
    fn test_last_stderr_line() {
        assert_eq!(last_stderr_line("line 1\nline 2\nline 3\n", "fallback"), "line 3");
        assert_eq!(last_stderr_line("only one line", "fallback"), "only one line");
        assert_eq!(last_stderr_line("", "fallback"), "fallback");
        assert_eq!(last_stderr_line("  \n   \n", "fallback"), "fallback");
        assert_eq!(last_stderr_line("error: npm install failed\n", "fallback"), "error: npm install failed");
    }

    #[test]
    fn test_run_setup_command_success() {
        let tmp = std::env::temp_dir().join(format!("kone_setup_test_succ_{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);
        let res = run_setup_command(&tmp, "echo hello");
        let _ = fs::remove_dir_all(&tmp);
        assert!(res.is_ok());
    }

    #[test]
    fn test_run_setup_command_failure_reports_stderr() {
        let tmp = std::env::temp_dir().join(format!("kone_setup_test_fail_{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);
        let res = run_setup_command(&tmp, "echo \"something went wrong\" >&2; exit 42");
        let _ = fs::remove_dir_all(&tmp);
        assert_eq!(res.unwrap_err(), "something went wrong");
    }

    #[test]
    fn test_run_setup_command_failure_without_stderr_reports_code() {
        let tmp = std::env::temp_dir().join(format!("kone_setup_test_nocode_{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);
        let res = run_setup_command(&tmp, "exit 7");
        let _ = fs::remove_dir_all(&tmp);
        assert_eq!(res.unwrap_err(), "Command exited with code 7");
    }

    #[test]
    fn test_resolve_repo_name() {
        assert_eq!(resolve_repo_name(Some("custom-repo"), "my-app"), "custom-repo");
        assert_eq!(resolve_repo_name(Some("  "), "my-app"), "my-app");
        assert_eq!(resolve_repo_name(None, "my-app"), "my-app");
        assert_eq!(resolve_repo_name(Some("   trimmed-name   "), "my-app"), "trimmed-name");
    }

    #[test]
    fn test_build_gh_repo_create_args() {
        let args_priv = build_gh_repo_create_args("my-repo", RepoVisibility::Private);
        assert_eq!(
            args_priv,
            vec![
                "repo",
                "create",
                "my-repo",
                "--private",
                "--source=.",
                "--remote=origin",
                "--push"
            ]
        );

        let args_pub = build_gh_repo_create_args("public-repo", RepoVisibility::Public);
        assert_eq!(
            args_pub,
            vec![
                "repo",
                "create",
                "public-repo",
                "--public",
                "--source=.",
                "--remote=origin",
                "--push"
            ]
        );
    }
}
