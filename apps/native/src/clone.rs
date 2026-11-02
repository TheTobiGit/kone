//! Clone runner and GitHub repository reference parsing.
//!
//! Mirrors Electron's `useGitClone.ts` and `packages/git-core/src/clone.ts`.

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::Sender,
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// A successfully parsed GitHub repository reference.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedRepo {
    pub owner: String,
    pub name: String,
    pub url: String,
}

fn is_valid_ident(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// Accept the shapes a person actually pastes: `owner/repo`, a github.com web URL
/// (with or without a trailing `/tree/branch`, `.git`, query, or hash), a bare
/// `github.com/owner/repo`, and `git@github.com:owner/repo.git`. Everything
/// normalizes to the canonical https clone URL.
///
/// Ported exactly from `apps/web/app/composables/useGitClone.ts`.
pub fn parse_repo_ref(input: &str) -> Option<ParsedRepo> {
    let s = input.trim().trim_end_matches('/');
    if s.is_empty() {
        return None;
    }

    let path_part: &str = if s.get(..15).is_some_and(|p| p.eq_ignore_ascii_case("git@github.com:")) {
        &s[15..]
    } else if let Some(scheme_len) = if s.get(..8).is_some_and(|p| p.eq_ignore_ascii_case("https://")) {
        Some(8)
    } else if s.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("http://")) {
        Some(7)
    } else {
        None
    } {
        let after_scheme = &s[scheme_len..];
        let end_of_authority = after_scheme.find(['/', '?', '#']).unwrap_or(after_scheme.len());
        let authority = &after_scheme[..end_of_authority];
        let host_port = authority.split('@').next_back().unwrap_or(authority);
        let host = host_port.split(':').next().unwrap_or(host_port);
        let host_clean = if host.get(..4).is_some_and(|p| p.eq_ignore_ascii_case("www.")) {
            &host[4..]
        } else {
            host
        };
        if !host_clean.eq_ignore_ascii_case("github.com") {
            return None;
        }
        let after_auth = &after_scheme[end_of_authority..];
        let end_of_path = after_auth.find(['?', '#']).unwrap_or(after_auth.len());
        let path = &after_auth[..end_of_path];
        path.trim_start_matches('/')
    } else if s.get(..11).is_some_and(|p| p.eq_ignore_ascii_case("github.com/")) {
        &s[11..]
    } else {
        // owner/repo shorthand: must contain exactly one '/' and both parts match [\w.-]+
        let mut parts = s.split('/');
        match (parts.next(), parts.next(), parts.next()) {
            (Some(o), Some(r), None) if is_valid_ident(o) && is_valid_ident(r) => s,
            _ => return None,
        }
    };

    if path_part.is_empty() {
        return None;
    }

    let segs: Vec<&str> = path_part.split('/').filter(|seg| !seg.is_empty()).collect();
    if segs.len() < 2 {
        return None;
    }

    let owner = segs[0];
    let raw_name = segs[1];
    let name = if raw_name.len() >= 4 && raw_name.get(raw_name.len() - 4..).is_some_and(|p| p.eq_ignore_ascii_case(".git")) {
        &raw_name[..raw_name.len() - 4]
    } else {
        raw_name
    };

    if owner.is_empty() || name.is_empty() {
        return None;
    }
    if !is_valid_ident(owner) || !is_valid_ident(name) {
        return None;
    }

    Some(ParsedRepo {
        owner: owner.to_string(),
        name: name.to_string(),
        url: format!("https://github.com/{owner}/{name}.git"),
    })
}

/// A progress tick parsed from `git clone --progress` stderr.
#[derive(Clone, Debug, PartialEq)]
pub struct CloneProgress {
    pub progress: f32, // 0.0 .. 1.0
    pub stage: String,
}

fn extract_percent(line: &str, marker: &str) -> Option<f32> {
    let idx = line.find(marker)?;
    let after = &line[idx + marker.len()..];
    let pct_idx = after.find('%')?;
    let num_str = after[..pct_idx].trim();
    let digits: String = num_str.chars().rev().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let digits: String = digits.chars().rev().collect();
    let val: f32 = digits.parse().ok()?;
    Some((val / 100.0).clamp(0.0, 1.0))
}

/// Parse chunks of `git clone --progress` stderr into a monotonic 0..1 progress tick.
///
/// Weight bands ported from `packages/git-core/src/clone.ts`:
/// - Counting objects: 0.0 .. 0.1
/// - Compressing objects: 0.1 .. 0.25
/// - Receiving objects: 0.25 .. 0.90
/// - Resolving deltas: 0.90 .. 0.98
/// - Checking out / Updating files: 0.98 .. 1.00
pub fn parse_clone_progress(chunk: &str) -> Option<CloneProgress> {
    let mut latest = None;
    for line in chunk.split(['\r', '\n']) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(pct) = extract_percent(line, "Counting objects:") {
            latest = Some(CloneProgress {
                progress: 0.0 + 0.1 * pct,
                stage: "Counting objects…".to_string(),
            });
        } else if let Some(pct) = extract_percent(line, "Compressing objects:") {
            latest = Some(CloneProgress {
                progress: 0.1 + 0.15 * pct,
                stage: "Compressing objects…".to_string(),
            });
        } else if let Some(pct) = extract_percent(line, "Receiving objects:") {
            latest = Some(CloneProgress {
                progress: 0.25 + 0.65 * pct,
                stage: "Receiving objects…".to_string(),
            });
        } else if let Some(pct) = extract_percent(line, "Resolving deltas:") {
            latest = Some(CloneProgress {
                progress: 0.9 + 0.08 * pct,
                stage: "Resolving deltas…".to_string(),
            });
        } else if let Some(pct) = extract_percent(line, "Updating files:")
            .or_else(|| extract_percent(line, "Checking out files:"))
        {
            latest = Some(CloneProgress {
                progress: 0.98 + 0.02 * pct,
                stage: "Checking out files…".to_string(),
            });
        }
    }
    latest
}

/// Peel git prefix wrappers ("fatal: ", "error: ") down to git's own message,
/// taking the last non-empty line of stderr.
pub fn peel_git_error(stderr: &str, fallback: &str) -> String {
    let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or(fallback);
    let trimmed = last.trim();
    if let Some(rest) = trimmed.strip_prefix("fatal: ") {
        rest.trim().to_string()
    } else if let Some(rest) = trimmed.strip_prefix("FATAL: ") {
        rest.trim().to_string()
    } else if let Some(rest) = trimmed.strip_prefix("error: ") {
        rest.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

/// How long a clone may run before it's killed, as in git-core.
const CLONE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

fn kill_group(pid: u32) {
    #[cfg(unix)]
    {
        // Terminate the process group: send SIGTERM immediately,
        // then escalate to SIGKILL after 1500 ms on a spawned thread.
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .output();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            let _ = std::process::Command::new("kill")
                .args(["-KILL", &format!("-{pid}")])
                .output();
        });
    }
    #[cfg(not(unix))]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output();
    }
}

/// Thread-safe cancellation controller for a clone session.
#[derive(Clone, Default)]
pub struct CloneCanceller {
    cancelled: Arc<AtomicBool>,
    child_pid: Arc<Mutex<Option<u32>>>,
}

impl CloneCanceller {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let pid = *self.child_pid.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pid) = pid {
            kill_group(pid);
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    fn set_pid(&self, pid: u32) {
        let mut lock = self.child_pid.lock().unwrap_or_else(|e| e.into_inner());
        *lock = Some(pid);
        drop(lock);
        if self.is_cancelled() {
            kill_group(pid);
        }
    }
}

/// Messages emitted by the clone runner to the UI thread.
#[derive(Clone, Debug, PartialEq)]
pub enum CloneUpdate {
    Progress(CloneProgress),
    Done(PathBuf),
    Error(String),
    Cancelled,
}

/// Runs `git clone --progress <url> <dest>` on a background thread.
///
/// Communicates progress ticks, cancellation, errors, and completion via `tx`.
/// Clones into a sibling staging dir and renames onto dest only after a zero exit.
pub fn run_clone(
    url: String,
    dest: PathBuf,
    canceller: CloneCanceller,
    tx: Sender<CloneUpdate>,
) {
    if canceller.is_cancelled() {
        let _ = tx.send(CloneUpdate::Cancelled);
        return;
    }

    if std::fs::symlink_metadata(&dest).is_ok() {
        let _ = tx.send(CloneUpdate::Error(format!(
            "A folder already exists at {}",
            dest.display()
        )));
        return;
    }

    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    if !parent.as_os_str().is_empty() {
        match std::fs::metadata(parent) {
            Ok(m) if m.is_file() => {
                let _ = tx.send(CloneUpdate::Error(
                    "The location is a file, not a folder.".to_string(),
                ));
                return;
            }
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                let _ = tx.send(CloneUpdate::Error(
                    "You don't have permission to use that location.".to_string(),
                ));
                return;
            }
            _ => {}
        }
        if let Err(e) = std::fs::create_dir_all(parent) {
            let msg = if e.kind() == std::io::ErrorKind::PermissionDenied {
                "You don't have permission to use that location.".to_string()
            } else {
                format!("Couldn't create destination folder: {e}")
            };
            let _ = tx.send(CloneUpdate::Error(msg));
            return;
        }
    }

    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging = parent.join(format!(".kone-clone-{pid}-{nanos}"));

    let _ = tx.send(CloneUpdate::Progress(CloneProgress {
        progress: 0.0,
        stage: "Connecting to github.com…".to_string(),
    }));

    let mut cmd = std::process::Command::new("git");
    cmd.args(["clone", "--progress", "--", &url]);
    cmd.arg(&staging);
    // Never block on an interactive credential prompt for a private repo;
    // fail fast so the UI can surface the auth error instead of hanging.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GCM_INTERACTIVE", "never");
    cmd.env("GIT_ASKPASS", "");
    cmd.env("LC_ALL", "C");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            let _ = tx.send(CloneUpdate::Error(match e.kind() {
                std::io::ErrorKind::NotFound => "Git isn't installed.".to_string(),
                _ => format!("Couldn't run git: {e}"),
            }));
            return;
        }
    };

    let pid = child.id();
    canceller.set_pid(pid);

    // Electron's clone gives up after 30 minutes; a silent, hung helper must
    // not keep the modal busy forever.
    let finished = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));
    {
        let (finished, timed_out) = (finished.clone(), timed_out.clone());
        std::thread::spawn(move || {
            let start = std::time::Instant::now();
            while start.elapsed() < CLONE_TIMEOUT {
                if finished.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            if !finished.load(Ordering::SeqCst) {
                timed_out.store(true, Ordering::SeqCst);
                kill_group(pid);
            }
        });
    }

    if canceller.is_cancelled() {
        kill_group(pid);
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&staging);
        let _ = tx.send(CloneUpdate::Cancelled);
        return;
    }

    let stderr = child.stderr.take();
    let mut captured_stderr = String::new();
    if let Some(mut reader) = stderr {
        use std::io::Read;
        let mut buf = [0u8; 1024];
        loop {
            if canceller.is_cancelled() {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    captured_stderr.push_str(&chunk);
                    if let Some(prog) = parse_clone_progress(&chunk) {
                        let _ = tx.send(CloneUpdate::Progress(prog));
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    }

    let status = child.wait();
    finished.store(true, Ordering::SeqCst);

    if timed_out.load(Ordering::SeqCst) {
        let _ = std::fs::remove_dir_all(&staging);
        let _ = tx.send(CloneUpdate::Error("The clone timed out after 30 minutes.".into()));
        return;
    }

    if canceller.is_cancelled() {
        let _ = std::fs::remove_dir_all(&staging);
        let _ = tx.send(CloneUpdate::Cancelled);
        return;
    }

    match status {
        Ok(s) if s.success() => {
            if std::fs::symlink_metadata(&dest).is_ok() {
                let _ = std::fs::remove_dir_all(&staging);
                let _ = tx.send(CloneUpdate::Error(format!(
                    "A folder already exists at {}",
                    dest.display()
                )));
                return;
            }
            if let Err(e) = std::fs::rename(&staging, &dest) {
                let _ = std::fs::remove_dir_all(&staging);
                let _ = tx.send(CloneUpdate::Error(format!("Couldn't move the clone into place: {e}")));
                return;
            }
            let _ = tx.send(CloneUpdate::Done(dest));
        }
        Ok(s) => {
            let _ = std::fs::remove_dir_all(&staging);
            let code = s.code().unwrap_or(1);
            let msg = peel_git_error(&captured_stderr, &format!("git clone exited with code {code}"));
            let _ = tx.send(CloneUpdate::Error(msg));
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            let _ = tx.send(CloneUpdate::Error(format!("Failed to wait for git: {e}")));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_repo_ref_shorthand() {
        assert_eq!(
            parse_repo_ref("owner/repo"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
        assert_eq!(
            parse_repo_ref("owner.name/repo-name_1"),
            Some(ParsedRepo {
                owner: "owner.name".into(),
                name: "repo-name_1".into(),
                url: "https://github.com/owner.name/repo-name_1.git".into(),
            })
        );
        // Trailing slash and whitespace
        assert_eq!(
            parse_repo_ref("  owner/repo/  "),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
    }

    #[test]
    fn test_parse_repo_ref_https_urls() {
        assert_eq!(
            parse_repo_ref("https://github.com/owner/repo"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
        assert_eq!(
            parse_repo_ref("https://github.com/owner/repo.git"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
        assert_eq!(
            parse_repo_ref("https://www.github.com/owner/repo"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
        assert_eq!(
            parse_repo_ref("http://github.com/owner/repo"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
        assert_eq!(
            parse_repo_ref("https://github.com/owner/repo/tree/main"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
        assert_eq!(
            parse_repo_ref("https://github.com/owner/repo/tree/feature/sub"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
        assert_eq!(
            parse_repo_ref("https://github.com/owner/repo?tab=readme#readme"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
        assert_eq!(
            parse_repo_ref("https://github.com/owner/repo.git?tab=readme"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
        assert_eq!(
            parse_repo_ref("https://user:pass@github.com/owner/repo"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
        assert_eq!(
            parse_repo_ref("https://github.com:443/owner/repo"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
        assert_eq!(
            parse_repo_ref("HTTPS://GITHUB.COM/OWNER/REPO"),
            Some(ParsedRepo {
                owner: "OWNER".into(),
                name: "REPO".into(),
                url: "https://github.com/OWNER/REPO.git".into(),
            })
        );
    }

    #[test]
    fn test_parse_repo_ref_bare_github() {
        assert_eq!(
            parse_repo_ref("github.com/owner/repo"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
        assert_eq!(
            parse_repo_ref("github.com/owner/repo.git"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
        assert_eq!(
            parse_repo_ref("github.com/owner/repo/tree/main"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
        assert_eq!(
            parse_repo_ref("GITHUB.COM/owner/repo"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
    }

    #[test]
    fn test_parse_repo_ref_ssh() {
        assert_eq!(
            parse_repo_ref("git@github.com:owner/repo.git"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
        assert_eq!(
            parse_repo_ref("git@github.com:owner/repo"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
        assert_eq!(
            parse_repo_ref("git@GITHUB.COM:owner/repo.git"),
            Some(ParsedRepo {
                owner: "owner".into(),
                name: "repo".into(),
                url: "https://github.com/owner/repo.git".into(),
            })
        );
    }

    #[test]
    fn test_parse_repo_ref_rejects() {
        assert_eq!(parse_repo_ref(""), None);
        assert_eq!(parse_repo_ref("   "), None);
        assert_eq!(parse_repo_ref("owner"), None);
        assert_eq!(parse_repo_ref("owner/"), None);
        assert_eq!(parse_repo_ref("/repo"), None);
        assert_eq!(parse_repo_ref("owner//repo"), None);
        assert_eq!(parse_repo_ref("owner/repo/extra"), None);
        assert_eq!(parse_repo_ref("owner/.git"), None);
        assert_eq!(parse_repo_ref("owner/repo$name"), None);
        assert_eq!(parse_repo_ref("owner repo/name"), None);
        assert_eq!(parse_repo_ref("https://gitlab.com/owner/repo"), None);
        assert_eq!(parse_repo_ref("https://evilgithub.com/owner/repo"), None);
        assert_eq!(parse_repo_ref("https://github.com.evil.com/owner/repo"), None);
        assert_eq!(parse_repo_ref("git@gitlab.com:owner/repo.git"), None);
        assert_eq!(parse_repo_ref("https://github.com/"), None);
        assert_eq!(parse_repo_ref("https://github.com/owner"), None);
        assert_eq!(parse_repo_ref("https://github.com/owner/.git"), None);
        assert_eq!(parse_repo_ref("git@github.com:"), None);
        assert_eq!(parse_repo_ref("git@github.com:owner"), None);
    }

    #[test]
    fn test_parse_clone_progress() {
        let c1 = parse_clone_progress("remote: Counting objects:  50% (5/10)\r");
        assert!(c1.is_some());
        let p1 = c1.unwrap();
        assert_eq!(p1.stage, "Counting objects…");
        assert!((p1.progress - 0.05).abs() < 1e-4);

        let c2 = parse_clone_progress("remote: Compressing objects: 100% (10/10), done.\n");
        assert!(c2.is_some());
        let p2 = c2.unwrap();
        assert_eq!(p2.stage, "Compressing objects…");
        assert!((p2.progress - 0.25).abs() < 1e-4);

        let c3 = parse_clone_progress("Receiving objects:  50% (500/1000), 1.2 MiB | 2.4 MiB/s\r");
        assert!(c3.is_some());
        let p3 = c3.unwrap();
        assert_eq!(p3.stage, "Receiving objects…");
        assert!((p3.progress - (0.25 + 0.65 * 0.5)).abs() < 1e-4);

        let c4 = parse_clone_progress("Resolving deltas: 100% (25/25)\r");
        assert!(c4.is_some());
        let p4 = c4.unwrap();
        assert_eq!(p4.stage, "Resolving deltas…");
        assert!((p4.progress - 0.98).abs() < 1e-4);

        let c5 = parse_clone_progress("Updating files: 100% (10/10), done.\n");
        assert!(c5.is_some());
        let p5 = c5.unwrap();
        assert_eq!(p5.stage, "Checking out files…");
        assert!((p5.progress - 1.0).abs() < 1e-4);

        // Multi-line chunk with carriage returns
        let multi = "Receiving objects:  10% (100/1000)\rReceiving objects:  80% (800/1000)\r";
        let cm = parse_clone_progress(multi).unwrap();
        assert_eq!(cm.stage, "Receiving objects…");
        assert!((cm.progress - (0.25 + 0.65 * 0.8)).abs() < 1e-4);

        // Non-progress line
        assert_eq!(parse_clone_progress("fatal: repository not found"), None);
    }

    #[test]
    fn test_peel_git_error() {
        assert_eq!(
            peel_git_error(
                "Cloning into 'foo'...\nfatal: repository 'https://github.com/foo/bar.git' not found",
                "failed"
            ),
            "repository 'https://github.com/foo/bar.git' not found"
        );
        assert_eq!(
            peel_git_error(
                "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
                "failed"
            ),
            "could not read Username for 'https://github.com': terminal prompts disabled"
        );
        assert_eq!(
            peel_git_error("", "Clone failed"),
            "Clone failed"
        );
    }

    #[test]
    fn test_run_clone_refuses_existing_dest() {
        let (tx, rx) = std::sync::mpsc::channel();
        let canceller = CloneCanceller::new();
        let tmp = std::env::temp_dir();
        run_clone(
            "https://github.com/owner/repo.git".into(),
            tmp.clone(),
            canceller,
            tx,
        );
        let msg = rx.recv().expect("message received");
        assert_eq!(
            msg,
            CloneUpdate::Error(format!("A folder already exists at {}", tmp.display()))
        );
    }

    #[test]
    fn test_run_clone_cancelled_early() {
        let (tx, rx) = std::sync::mpsc::channel();
        let canceller = CloneCanceller::new();
        canceller.cancel();
        assert!(canceller.is_cancelled());
        let dest = std::env::temp_dir().join("kone_nonexistent_clone_dest_test");
        run_clone(
            "https://github.com/owner/repo.git".into(),
            dest,
            canceller,
            tx,
        );
        let msg = rx.recv().expect("message received");
        assert_eq!(msg, CloneUpdate::Cancelled);
    }

    #[test]
    fn test_run_clone_staging_cleanup_on_error() {
        let (tx, rx) = std::sync::mpsc::channel();
        let canceller = CloneCanceller::new();
        let parent = std::env::temp_dir().join(format!("kone_staging_cleanup_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&parent);
        let dest = parent.join("dest_repo");

        run_clone(
            "file:///nonexistent/repo".into(),
            dest.clone(),
            canceller,
            tx,
        );

        let msg = rx
            .iter()
            .find(|m| !matches!(m, CloneUpdate::Progress(_)))
            .expect("final message received");
        assert!(matches!(msg, CloneUpdate::Error(_)));
        assert!(!dest.exists());

        let has_staging = std::fs::read_dir(&parent)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with(".kone-clone-"));
        assert!(!has_staging);

        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn test_run_clone_parent_is_file() {
        let (tx, rx) = std::sync::mpsc::channel();
        let canceller = CloneCanceller::new();
        let test_file = std::env::temp_dir().join(format!("kone_file_parent_test_{}", std::process::id()));
        let _ = std::fs::write(&test_file, b"test");
        let dest = test_file.join("sub_repo");

        run_clone(
            "https://github.com/owner/repo.git".into(),
            dest,
            canceller,
            tx,
        );

        let msg = rx.recv().expect("message received");
        assert_eq!(
            msg,
            CloneUpdate::Error("The location is a file, not a folder.".to_string())
        );

        let _ = std::fs::remove_file(&test_file);
    }

    #[test]
    fn parse_repo_ref_survives_multibyte_input() {
        assert_eq!(parse_repo_ref("éééééééé"), None);
        assert_eq!(parse_repo_ref("ééééé/x"), None);
        assert_eq!(parse_repo_ref("https://ééé"), None);
    }
}
