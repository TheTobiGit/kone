//! Recents use git-core's status counts; the picker's detect/shortstat stays separate.
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    path::Path,
    process::{Command, Stdio},
};

use kone_rpc::{Branch, ChangedFile, FileChange, RepoSummary};

const FILE_CAP: u64 = 512 * 1024;
// Bound disk work per repo even when a generated tree is accidentally unignored.
const UNTRACKED_CAP: usize = 2000;
const READ_CAP: u64 = 32 * 1024 * 1024;

fn git(dir: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .arg("--no-optional-locks")
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status.success().then_some(out.stdout)
}

fn lines(bytes: &[u8]) -> u32 {
    if bytes.is_empty() || bytes.contains(&0) {
        return 0;
    }
    let count =
        bytes.iter().filter(|&&b| b == b'\n').count() + usize::from(bytes.last() != Some(&b'\n'));
    count.min(u32::MAX as usize) as u32
}

#[derive(Default)]
struct ReadBudget {
    files: usize,
    bytes: u64,
}

impl ReadBudget {
    fn count(&mut self, root: &Path, name: &[u8]) -> u32 {
        if self.files >= UNTRACKED_CAP || self.bytes >= READ_CAP {
            return 0;
        }
        self.files += 1;
        #[cfg(unix)]
        let path = {
            use std::os::unix::ffi::OsStrExt;
            root.join(std::ffi::OsStr::from_bytes(name))
        };
        #[cfg(not(unix))]
        let path = root.join(String::from_utf8_lossy(name).as_ref());
        // Reject directories and special files before opening (e.g. a symlink
        // to a FIFO must not stall the background reader).
        let Ok(meta) = std::fs::metadata(&path) else {
            return 0;
        };
        if !meta.is_file() || meta.len() > FILE_CAP {
            return 0;
        }
        let Ok(file) = File::open(path) else {
            return 0;
        };
        let Ok(meta) = file.metadata() else {
            return 0;
        };
        if !meta.is_file() || meta.len() > FILE_CAP {
            return 0;
        }
        // Read one extra byte to catch files growing after metadata, without
        // allowing that race to exceed either the per-file or total budget.
        let limit = (FILE_CAP + 1).min(READ_CAP - self.bytes);
        if meta.len() > limit {
            return 0;
        }
        let mut bytes = Vec::new();
        let result = file.take(limit).read_to_end(&mut bytes);
        self.bytes += bytes.len() as u64;
        if result.is_err() || bytes.len() as u64 > FILE_CAP || bytes.len() as u64 == limit {
            return 0;
        }
        lines(&bytes)
    }
}

/// Blocking, called only by read_tiles on the background executor. NUL records
/// preserve spaces, tabs and newlines in paths on both status and numstat sides.
pub(super) fn summary(root: &Path) -> Option<RepoSummary> {
    if std::fs::symlink_metadata(root.join(".git")).is_err() {
        return None;
    }
    let status = git(
        root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "-z",
        ],
    )?;
    let diff = git(
        root,
        &["diff", "--numstat", "-z", "--no-renames", "HEAD", "--"],
    )
    .or_else(|| {
        git(
            root,
            &["diff", "--numstat", "-z", "--no-renames", "--cached", "--"],
        )
    })
    .unwrap_or_default();
    let counts: HashMap<_, _> = diff
        .split(|&b| b == 0)
        .filter_map(|record| {
            let mut parts = record.splitn(3, |&b| b == b'\t');
            let number = |s| {
                std::str::from_utf8(s)
                    .ok()
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(0)
            };
            Some((
                parts.next().map(number)?,
                parts.next().map(number)?,
                parts.next()?.to_vec(),
            ))
        })
        .map(|(a, r, path)| (path, (a, r)))
        .collect();
    let mut summary = RepoSummary {
        repo: true,
        ..Default::default()
    };
    let mut budget = ReadBudget::default();
    let mut records = status.split(|&b| b == 0);
    let mut oid = None;
    let mut detached = false;
    while let Some(record) = records.next() {
        if let Some(name) = record.strip_prefix(b"# branch.head ") {
            detached = name == b"(detached)";
            if !detached {
                summary.branch = Branch::Named(String::from_utf8_lossy(name).into_owned());
            }
            continue;
        }
        if let Some(sha) = record.strip_prefix(b"# branch.oid ") {
            if sha != b"(initial)" {
                oid = Some(String::from_utf8_lossy(&sha[..sha.len().min(7)]).into_owned());
            }
            continue;
        }
        let (name, change, untracked) = match record.first() {
            Some(b'?') => (&record[2..], FileChange::Added, true),
            Some(kind @ (b'1' | b'2' | b'u')) => {
                let fields = match kind {
                    b'1' => 8,
                    b'2' => 9,
                    _ => 10,
                };
                let mut parts = record.splitn(fields + 1, |&b| b == b' ');
                let xy = parts.nth(1).unwrap_or(b"..");
                let Some(name) = parts.last() else {
                    continue;
                };
                if *kind == b'2' {
                    records.next();
                }
                let code = if xy.get(1) != Some(&b'.') {
                    xy.get(1)
                } else {
                    xy.first()
                };
                let change = match code {
                    Some(b'A') => FileChange::Added,
                    Some(b'D') => FileChange::Deleted,
                    _ => FileChange::Modified,
                };
                (name, change, false)
            }
            _ => continue,
        };
        let (added, removed) = if untracked {
            (budget.count(root, name), 0)
        } else {
            counts.get(name).copied().unwrap_or_default()
        };
        summary.added = summary.added.saturating_add(added);
        summary.removed = summary.removed.saturating_add(removed);
        if summary.files.len() < 3 {
            summary.files.push(ChangedFile {
                name: String::from_utf8_lossy(name).into_owned(),
                change,
                added,
                removed,
            });
        }
    }
    if detached {
        summary.branch = oid.map(Branch::Detached).unwrap_or_default();
    }
    Some(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::prelude::v1::test;

    #[test]
    fn whole_file_lines_match_git_core() {
        for (bytes, expected) in [
            (b"".as_slice(), 0),
            (b"a", 1),
            (b"a\n", 1),
            (b"\n\n", 2),
            (b"a\nb", 2),
            (b"a\0b", 0),
        ] {
            assert_eq!(lines(bytes), expected);
        }
    }

    #[test]
    fn recents_counts_untracked_but_picker_stays_tracked_only() {
        let root = std::env::temp_dir().join(format!("kone-recents-git-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        assert!(git(&root, &["init", "-q"]).is_some());
        std::fs::write(root.join(".gitignore"), "ignored\n").unwrap();
        std::fs::write(root.join("a tracked\tfile"), "old\n").unwrap();
        assert!(git(&root, &["add", "."]).is_some());
        assert!(
            git(
                &root,
                &[
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.com",
                    "commit",
                    "-qm",
                    "initial"
                ]
            )
            .is_some()
        );
        std::fs::write(root.join("a tracked\tfile"), "new\nextra\n").unwrap();
        std::fs::create_dir(root.join("nested")).unwrap();
        std::fs::write(root.join("nested/new"), "one\ntwo").unwrap();
        std::fs::write(root.join("ignored"), "ignored\n").unwrap();
        std::fs::write(root.join("binary"), b"a\0b").unwrap();
        std::fs::write(root.join("large"), vec![b'x'; FILE_CAP as usize + 1]).unwrap();
        let s = summary(&root).unwrap();
        assert_eq!((s.added, s.removed), (4, 1));
        assert_eq!(s.files[0].name, "a tracked\tfile");
        assert_eq!((s.files[0].added, s.files[0].removed), (2, 1));
        assert_eq!(
            crate::folder_picker::repo_summary(&root).map(|s| (s.added, s.removed)),
            Some((2, 1))
        );
        let mut budget = ReadBudget::default();
        std::fs::write(root.join("at-cap"), vec![b'x'; FILE_CAP as usize]).unwrap();
        assert_eq!(budget.count(&root, b"at-cap"), 1);
        assert_eq!(budget.bytes, FILE_CAP);
        assert_eq!(budget.count(&root, b"large"), 0);
        assert_eq!(budget.bytes, FILE_CAP);
        assert_eq!(budget.count(&root, b"binary"), 0);
        assert_eq!(budget.bytes, FILE_CAP + 3);
        assert_eq!(budget.count(&root, b"nested/new"), 2);
        assert_eq!(budget.bytes, FILE_CAP + 10);

        // The same parser handles staged deletion and NUL-delimited rename
        // records without consuming the following change as the source path.
        assert!(git(&root, &["mv", "a tracked\tfile", "renamed"]).is_some());
        std::fs::remove_file(root.join(".gitignore")).unwrap();
        let renamed = summary(&root).unwrap();
        assert_eq!(renamed.files[0].change, FileChange::Deleted);
        assert_eq!(renamed.files[0].removed, 1);
        assert_eq!(renamed.files[1].name, "renamed");

        // With no HEAD, staged content uses the cached numstat fallback.
        let unborn = root.join("unborn");
        std::fs::create_dir(&unborn).unwrap();
        assert!(git(&unborn, &["init", "-q"]).is_some());
        std::fs::write(unborn.join("staged"), "one\ntwo\n").unwrap();
        assert!(git(&unborn, &["add", "."]).is_some());
        std::fs::write(unborn.join("untracked"), "three").unwrap();
        let s = summary(&unborn).unwrap();
        assert_eq!((s.added, s.removed), (3, 0));
        assert_eq!(s.files[0].change, FileChange::Added);
        assert_eq!(s.files[1].name, "untracked");
        let mut budget = ReadBudget {
            files: UNTRACKED_CAP,
            bytes: 0,
        };
        assert_eq!(budget.count(&root, b"nested/new"), 0);
        let mut budget = ReadBudget {
            files: 0,
            bytes: READ_CAP - 1,
        };
        assert_eq!(budget.count(&root, b"nested/new"), 0);
    }
}
