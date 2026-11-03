use super::*;
use std::{fs, path::PathBuf, process::Command, sync::atomic::AtomicBool};
struct Repo(PathBuf);
impl Repo {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "kone-native-git-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&p).unwrap();
        let repo = Self(p);
        repo.git(&["init", "-q", "-b", "main"]);
        repo
    }
    fn git(&self, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.0)
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    fn write(&self, name: &str, text: impl AsRef<[u8]>) {
        fs::write(self.0.join(name), text).unwrap();
    }
    fn snapshot(&self) -> GitSnapshot {
        NativeGit
            .snapshot(&self.0, &AtomicBool::new(false))
            .unwrap()
            .unwrap()
    }
    fn detail(&self, file: &str, staged: bool) -> FileDetail {
        NativeGit
            .detail(&self.0, file, staged, &AtomicBool::new(false))
            .unwrap()
    }
    fn commit(&self) {
        self.git(&["add", "."]);
        self.git(&["commit", "-qm", "initial"]);
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn partial_stage_and_lane_specific_diff() {
    let repo = Repo::new();
    repo.write("partial.txt", "original\n");
    repo.commit();
    repo.write("partial.txt", "staged\n");
    repo.git(&["add", "partial.txt"]);
    repo.write("partial.txt", "working\n");
    let snapshot = repo.snapshot();
    let c = &snapshot.changes[0];
    assert!(c.staged && c.unstaged);
    assert_eq!((c.added, c.removed), (1, 1));
    assert!(c.modified_at.is_some());
    assert!(!snapshot.clean);
    let staged = repo.detail("partial.txt", true).diff.unwrap();
    let changed = repo.detail("partial.txt", false).diff.unwrap();
    assert_eq!(staged.hunks[0].lines.len(), 2);
    assert_eq!(staged.hunks[0].lines[1].text, "staged");
    assert_eq!(changed.hunks[0].lines[1].text, "working");
}
#[test]
fn unicode_newlines_rename_and_deletion() {
    let repo = Repo::new();
    repo.write("old.txt", "old\n");
    repo.write("delete.txt", "gone\n");
    repo.commit();
    repo.git(&["mv", "old.txt", "new ü\n.txt"]);
    fs::remove_file(repo.0.join("delete.txt")).unwrap();
    repo.write("new\tfile.txt", "one\ntwo");
    let snapshot = repo.snapshot();
    let renamed = snapshot
        .changes
        .iter()
        .find(|c| c.path == "new ü\n.txt")
        .unwrap();
    assert_eq!(renamed.from.as_deref(), Some("old.txt"));
    assert!(renamed.staged);
    let new = snapshot
        .changes
        .iter()
        .find(|c| c.path == "new\tfile.txt")
        .unwrap();
    assert_eq!(new.added, 2);
    assert_eq!(repo.detail("new\tfile.txt", false).diff.unwrap().added, 2);
    let deleted = snapshot
        .changes
        .iter()
        .find(|c| c.path == "delete.txt")
        .unwrap();
    assert_eq!(deleted.removed, 1);
    assert!(deleted.modified_at.is_none());
    assert_eq!(repo.detail("delete.txt", false).diff.unwrap().removed, 1);
}
#[test]
fn unborn_detached_nested_and_linked_worktree() {
    let repo = Repo::new();
    let s = repo.snapshot();
    assert!(s.head.is_none() && s.clean);
    assert_eq!(s.branch.as_deref(), Some("main"));
    repo.write("a", "hello\n");
    repo.git(&["add", "a"]);
    assert_eq!(repo.snapshot().changes[0].added, 1);
    repo.commit();
    fs::create_dir(repo.0.join("nested")).unwrap();
    let s = NativeGit
        .snapshot(&repo.0.join("nested"), &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert_eq!(s.root, repo.0.to_string_lossy());
    let linked = repo.0.join("linked");
    repo.git(&[
        "worktree",
        "add",
        "-q",
        "--detach",
        linked.to_str().unwrap(),
        "HEAD",
    ]);
    let s = NativeGit
        .snapshot(&linked, &AtomicBool::new(false))
        .unwrap()
        .unwrap();
    assert!(s.detached && s.head.is_some() && s.branch.is_none());
    repo.git(&["worktree", "remove", linked.to_str().unwrap()]);
}
#[test]
fn binary_large_and_empty_files_have_explicit_states() {
    let repo = Repo::new();
    repo.write("binary", [0, 1, 2]);
    repo.write("large", vec![b'x'; FILE_CAP + 1]);
    repo.write("empty", "");
    assert!(repo.detail("binary", false).content.unwrap().binary);
    assert!(repo.detail("large", false).limited);
    assert_eq!(
        repo.detail("empty", false).content.unwrap().text.as_deref(),
        Some("")
    );
    assert!(!repo.snapshot().clean);
}
#[test]
fn non_repo_missing_and_cancellation_remain_distinct() {
    let repo = Repo::new();
    let plain = repo.0.join("plain");
    fs::create_dir(&plain).unwrap();
    fs::remove_dir_all(repo.0.join(".git")).unwrap();
    assert!(
        NativeGit
            .snapshot(&plain, &AtomicBool::new(false))
            .unwrap()
            .is_none()
    );
    assert!(
        NativeGit
            .snapshot(&repo.0.join("missing"), &AtomicBool::new(false))
            .is_err()
    );
    assert!(NativeGit.snapshot(&repo.0, &AtomicBool::new(true)).is_err());
}
#[test]
fn rejects_path_and_symlink_escapes() {
    let repo = Repo::new();
    assert!(repo.detail_error("../outside"));
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(std::env::temp_dir(), repo.0.join("escape")).unwrap();
        assert!(repo.detail_error("escape/file"));
        repo.write("regular", "inside\n");
        std::os::unix::fs::symlink("regular", repo.0.join("link")).unwrap();
        assert!(repo.detail("link", false).diff.is_none());
    }
}
impl Repo {
    fn detail_error(&self, file: &str) -> bool {
        NativeGit
            .detail(&self.0, file, false, &AtomicBool::new(false))
            .is_err()
    }
}
#[test]
fn upstream_ahead_and_behind() {
    let repo = Repo::new();
    repo.write("a", "a\n");
    repo.commit();
    repo.git(&["branch", "upstream"]);
    repo.git(&["branch", "--set-upstream-to=upstream"]);
    repo.write("b", "b\n");
    repo.commit();
    assert_eq!(repo.snapshot().ahead, 1);
    repo.git(&["checkout", "-q", "upstream"]);
    repo.write("c", "c\n");
    repo.commit();
    repo.git(&["checkout", "-q", "main"]);
    let s = repo.snapshot();
    assert_eq!((s.ahead, s.behind), (1, 1));
}
#[cfg(unix)]
#[test]
fn shared_runner_honors_deadline_and_cancel() {
    let repo = Repo::new();
    let result = crate::repo::read_git(
        &repo.0,
        &["status"],
        std::time::Instant::now() - std::time::Duration::from_millis(1),
        &AtomicBool::new(false),
        1024,
        false,
    );
    assert!(result.is_err());
    assert!(
        crate::repo::read_git(
            &repo.0,
            &["status"],
            std::time::Instant::now() + TIMEOUT,
            &AtomicBool::new(true),
            1024,
            false
        )
        .is_err()
    );
}
#[test]
fn untracked_counts_are_not_limited_by_preview_line_budget() {
    let repo = Repo::new();
    repo.write("many.txt", "line\n".repeat(5000));
    assert_eq!(repo.snapshot().changes[0].added, 5000);
    assert!(repo.detail("many.txt", false).limited);
}
#[test]
fn output_limit_is_an_error_not_a_clean_snapshot() {
    let repo = Repo::new();
    let error = crate::repo::read_git(
        &repo.0,
        &["status"],
        std::time::Instant::now() + TIMEOUT,
        &AtomicBool::new(false),
        1,
        false,
    )
    .unwrap_err();
    assert!(error.contains("limit"));
}
#[test]
fn conflicted_files_show_numbered_worktree_diff() {
    let repo = Repo::new();
    repo.write("conflict.txt", "base\n");
    repo.commit();
    repo.git(&["checkout", "-qb", "other"]);
    repo.write("conflict.txt", "theirs\n");
    repo.commit();
    repo.git(&["checkout", "-q", "main"]);
    repo.write("conflict.txt", "ours\n");
    repo.commit();
    let out = Command::new("git")
        .arg("-C")
        .arg(&repo.0)
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "merge",
            "other",
        ])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let snapshot = repo.snapshot();
    assert_eq!(snapshot.changes[0].status, "conflicted");
    assert!(!snapshot.changes[0].staged && snapshot.changes[0].unstaged);
    let diff = repo.detail("conflict.txt", false).diff.unwrap();
    assert!(!diff.hunks.is_empty());
    assert!(
        diff.hunks[0]
            .lines
            .iter()
            .any(|line| line.text.starts_with("<<<<<<<"))
    );
}

#[test]
fn staged_preview_uses_index_even_when_worktree_is_binary_or_large() {
    let repo = Repo::new();
    repo.write("file", "base\n");
    repo.commit();
    repo.write("file", "staged\n");
    repo.git(&["add", "file"]);
    for worktree in [vec![0, 1], vec![b'x'; FILE_CAP + 1]] {
        repo.write("file", worktree);
        let detail = repo.detail("file", true);
        assert!(!detail.limited);
        assert_eq!(detail.content.unwrap().text.as_deref(), Some("staged\n"));
        assert_eq!(detail.diff.unwrap().hunks[0].lines[1].text, "staged");
    }
    fs::remove_file(repo.0.join("file")).unwrap();
    assert_eq!(
        repo.detail("file", true).content.unwrap().text.as_deref(),
        Some("staged\n")
    );
}

#[test]
fn detail_paths_are_literal_including_pathspec_magic() {
    let repo = Repo::new();
    for name in ["[a].txt", "a.txt", ":(glob)*.txt"] {
        repo.write(name, "base\n");
    }
    repo.commit();
    repo.write("[a].txt", "brackets\n");
    repo.write("a.txt", "other\n");
    repo.write(":(glob)*.txt", "magic\n");
    for (name, expected) in [("[a].txt", "brackets"), (":(glob)*.txt", "magic")] {
        let diff = repo.detail(name, false).diff.unwrap();
        assert_eq!(diff.added, 1);
        assert_eq!(diff.hunks[0].lines[1].text, expected);
    }
    repo.write("[u].txt", "untracked\n");
    assert_eq!(repo.detail("[u].txt", false).diff.unwrap().added, 1);
}
