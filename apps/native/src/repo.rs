//! Tracked-only repository metadata for picker rows and project views.
use std::{collections::HashMap, fs, path::{Path, PathBuf}, time::{Duration, Instant}};
use kone_rpc::{Branch, RepoSummary};

fn is_repo_root(dir: &Path) -> bool {
    fs::symlink_metadata(dir.join(".git")).is_ok()
}

fn git_dir(dir: &Path) -> Option<PathBuf> {
    let marker = dir.join(".git");
    let metadata = fs::symlink_metadata(&marker).ok()?;
    if metadata.is_dir() {
        return Some(marker);
    }
    let text = fs::read_to_string(&marker).ok()?;
    let rest = text.trim().strip_prefix("gitdir:")?.trim();
    let path = Path::new(rest);
    Some(if path.is_absolute() { path.to_path_buf() } else { dir.join(path) })
}

pub(crate) fn read_branch(dir: &Path) -> Branch {
    let Some(git) = git_dir(dir) else { return Branch::Unknown };
    let Ok(head) = fs::read_to_string(git.join("HEAD")) else { return Branch::Unknown };
    let head = head.trim();
    if let Some(name) = head.strip_prefix("ref: refs/heads/") {
        return Branch::Named(name.to_string());
    }
    let short: String = head.chars().take(7).collect();
    if short.is_empty() { Branch::Unknown } else { Branch::Detached(short) }
}

pub(crate) fn repo_summary(dir: &Path) -> Option<RepoSummary> {
    if !is_repo_root(dir) {
        return None;
    }
    let (added, removed) = cached_diff_stat(dir);
    Some(RepoSummary {
        repo: true,
        branch: read_branch(dir),
        added,
        removed,
        files: Vec::new(),
    })
}

/// How long a computed diffstat is trusted while `.git/index` and `.git/HEAD`
/// are unchanged. Untracked edits don't touch either file, so the TTL bounds
/// how stale a row can read; reopening the picker within it costs no git runs.
const SUMMARY_TTL: Duration = Duration::from_secs(5);
const SUMMARY_CACHE_MAX: usize = 256;

type SummaryKey = (Option<std::time::SystemTime>, Option<std::time::SystemTime>);
type SummaryCache = std::sync::Mutex<HashMap<PathBuf, (SummaryKey, Instant, (u32, u32))>>;

fn summary_cache() -> &'static SummaryCache {
    static CACHE: std::sync::OnceLock<SummaryCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn summary_key(dir: &Path) -> SummaryKey {
    let mtime = |name: &str| {
        git_dir(dir).and_then(|g| fs::metadata(g.join(name)).ok()).and_then(|m| m.modified().ok())
    };
    (mtime("index"), mtime("HEAD"))
}

/// `diff_stat` behind a small per-repo cache keyed by the index/HEAD mtimes.
pub(crate) fn cached_diff_stat(dir: &Path) -> (u32, u32) {
    let key = summary_key(dir);
    if let Ok(cache) = summary_cache().lock()
        && let Some((k, at, stat)) = cache.get(dir)
        && *k == key
        && at.elapsed() < SUMMARY_TTL
    {
        return *stat;
    }
    let stat = diff_stat(dir);
    if let Ok(mut cache) = summary_cache().lock() {
        if cache.len() >= SUMMARY_CACHE_MAX {
            cache.retain(|_, (_, at, _)| at.elapsed() < SUMMARY_TTL);
            if cache.len() >= SUMMARY_CACHE_MAX {
                cache.clear();
            }
        }
        cache.insert(dir.to_path_buf(), (key, Instant::now(), stat));
    }
    stat
}

fn git_out(dir: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let mut command = std::process::Command::new("git");
    command.arg("-C")
        .arg(dir)
        .arg("--no-optional-locks")
        .args(args)
        ;
    let output = crate::process::output(&mut command, Duration::from_secs(2), &std::sync::atomic::AtomicBool::new(false), 8 * 1024 * 1024).ok()?;
    output.status.success().then_some(output.stdout)
}

/// Lines added and removed in the working tree, as git-core counts them:
/// tracked changes vs `HEAD` (staged and unstaged together; only the index on
/// an unborn branch). Untracked files aren't counted: git-core's `detect()`
/// takes its numbers from `git diff --shortstat HEAD`, which skips them.
/// Runs on the listing's background thread; a missing `git` or a failed read
/// comes back as no changes rather than invented numbers.
pub(crate) fn diff_stat(dir: &Path) -> (u32, u32) {
    let numstat = git_out(dir, &["diff", "--numstat", "--no-renames", "HEAD", "--"])
        .or_else(|| git_out(dir, &["diff", "--numstat", "--no-renames", "--cached", "--"]));
    let mut added = 0u32;
    let mut removed = 0u32;
    if let Some(out) = numstat {
        for line in String::from_utf8_lossy(&out).lines() {
            let mut parts = line.split('\t');
            // Binary files report "-" for both counts; they add no lines.
            let a = parts.next().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
            let r = parts.next().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
            added = added.saturating_add(a);
            removed = removed.saturating_add(r);
        }
    }
    (added, removed)
}


#[cfg(test)]
mod summary_tests {
    use super::{cached_diff_stat, diff_stat, read_branch, Branch};
    use std::{fs, path::{Path, PathBuf}, time::Duration};

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .arg("-C").arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .output().unwrap().status.success();
        assert!(ok, "git {args:?}");
    }

    fn repo(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kone-summary-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        git(&d, &["init", "-q", "-b", "main"]);
        d
    }

    #[test]
    fn skips_untracked_like_git_core() {
        let d = repo("untracked");
        fs::write(d.join("a.txt"), "one\ntwo\nthree").unwrap();
        assert_eq!(diff_stat(&d), (0, 0));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn empty_repo_counts_staged_and_names_branch() {
        let d = repo("empty");
        assert_eq!(diff_stat(&d), (0, 0));
        fs::write(d.join("s.txt"), "a\nb\n").unwrap();
        git(&d, &["add", "s.txt"]);
        assert_eq!(diff_stat(&d), (2, 0));
        assert!(matches!(read_branch(&d), Branch::Named(ref n) if n == "main"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn tracked_changes_and_detached_head() {
        let d = repo("tracked");
        fs::write(d.join("f.txt"), "a\nb\n").unwrap();
        git(&d, &["add", "."]);
        git(&d, &["commit", "-q", "-m", "init"]);
        fs::write(d.join("f.txt"), "a\nc\nd\n").unwrap();
        assert_eq!(diff_stat(&d), (2, 1));
        git(&d, &["checkout", "-q", "--detach"]);
        assert!(matches!(read_branch(&d), Branch::Detached(ref s) if s.len() == 7));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn cache_reuses_until_index_changes() {
        let d = repo("cache");
        fs::write(d.join("f.txt"), "a\n").unwrap();
        git(&d, &["add", "."]);
        assert_eq!(cached_diff_stat(&d), (1, 0));
        // An untracked file within the TTL is served from cache…
        fs::write(d.join("u.txt"), "x\n").unwrap();
        assert_eq!(cached_diff_stat(&d), (1, 0));
        // …but staging it moves the index and recomputes.
        std::thread::sleep(Duration::from_millis(20));
        git(&d, &["add", "u.txt"]);
        assert_eq!(cached_diff_stat(&d), (2, 0));
        let _ = fs::remove_dir_all(&d);
    }
}
