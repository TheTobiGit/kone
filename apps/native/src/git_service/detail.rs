use super::*;
use std::{path::Path, sync::atomic::AtomicBool, time::Instant};
pub(super) fn detail(
    path: &Path,
    file: &str,
    staged: bool,
    cancel: &AtomicBool,
) -> Result<FileDetail, String> {
    let deadline = Instant::now() + TIMEOUT;
    let root = root(path, deadline, cancel)?.ok_or("Not a git repository")?;
    let full = safe_path(&root, file)?;
    // A staged row previews the index, even if the worktree has since become
    // binary, oversized, deleted, or a different file type.
    let content = if staged {
        index_content(&root, file, deadline, cancel)?
    } else {
        read_file(&full)?
    };
    let too_many_lines = content
        .text
        .as_ref()
        .is_some_and(|s| s.lines().count() > 4000);
    if too_many_lines {
        return Ok(FileDetail {
            limited: true,
            content: None,
            ..Default::default()
        });
    }
    if content.truncated || content.binary {
        return Ok(FileDetail {
            limited: content.truncated,
            content: Some(content),
            ..Default::default()
        });
    }
    if !staged && std::fs::symlink_metadata(&full).is_ok_and(|m| !m.is_file()) {
        return Ok(FileDetail {
            content: Some(content),
            ..Default::default()
        });
    }
    let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
    if staged {
        args.push("--cached");
    } else {
        // A conflicted index otherwise emits a combined (@@@) diff. Compare
        // the worktree with stage 2 so the same numbered unified view works.
        args.push("--ours");
    }
    args.extend(["--", file]);
    let mut output = crate::repo::read_git(&root, &args, deadline, cancel, FILE_CAP, false);
    if !staged && output.as_ref().is_ok_and(Vec::is_empty) {
        let untracked = crate::repo::read_git(
            &root,
            &[
                "ls-files",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
                file,
            ],
            deadline,
            cancel,
            FILE_CAP,
            false,
        )?;
        if !untracked.is_empty() {
            output = crate::repo::read_git(
                &root,
                &[
                    "diff",
                    "--no-index",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--",
                    "/dev/null",
                    file,
                ],
                deadline,
                cancel,
                FILE_CAP,
                true,
            );
        }
    }
    let output = match output {
        Ok(out) => out,
        Err(e) if e == "Git output exceeds the preview limit" => {
            return Ok(FileDetail {
                content: Some(content),
                limited: true,
                ..Default::default()
            });
        }
        Err(e) => return Err(e),
    };
    let diff = parse(file, &String::from_utf8_lossy(&output));
    let limited = diff.hunks.iter().map(|h| h.lines.len()).sum::<usize>() > 4000;
    check(deadline, cancel)?;
    Ok(FileDetail {
        diff: (!limited).then_some(diff),
        content: Some(content),
        limited,
    })
}
fn index_content(
    root: &Path,
    file: &str,
    deadline: Instant,
    cancel: &AtomicBool,
) -> Result<FileContent, String> {
    let entries = crate::repo::read_git(
        root,
        &["ls-files", "--stage", "-z", "--", file],
        deadline,
        cancel,
        FILE_CAP,
        false,
    )?;
    let header = entries.split(|&b| b == b'\t').next().unwrap_or_default();
    let fields: Vec<_> = header.split(|&b| b == b' ').collect();
    // A staged deletion has no index entry. Gitlinks have no blob content.
    if entries.is_empty() || fields.first() == Some(&b"160000".as_slice()) {
        return Ok(FileContent::default());
    }
    let oid = fields.get(1).ok_or("Invalid index entry")?;
    let oid = std::str::from_utf8(oid).map_err(|_| "Invalid index object")?;
    let bytes = match crate::repo::read_git(
        root,
        &["cat-file", "blob", oid],
        deadline,
        cancel,
        FILE_CAP,
        false,
    ) {
        Ok(bytes) => bytes,
        Err(e) if e == "Git output exceeds the preview limit" => {
            return Ok(FileContent {
                truncated: true,
                ..Default::default()
            });
        }
        Err(e) => return Err(e),
    };
    let binary = bytes.contains(&0);
    Ok(FileContent {
        text: (!binary).then(|| String::from_utf8_lossy(&bytes).into_owned()),
        binary,
        truncated: false,
    })
}

fn parse(file: &str, out: &str) -> FileDiff {
    let mut diff = FileDiff {
        path: file.into(),
        ..Default::default()
    };
    let (mut old, mut new) = (0u32, 0u32);
    for raw in out.lines() {
        if raw.starts_with("Binary files") || raw.starts_with("GIT binary patch") {
            diff.binary = true;
            continue;
        }
        if raw.starts_with("@@ ") {
            let mut fields = raw.split_whitespace();
            fields.next();
            let start = |s: Option<&str>| {
                s.and_then(|s| s.get(1..))
                    .and_then(|s| s.split(',').next())
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(0)
            };
            old = start(fields.next());
            new = start(fields.next());
            let header = raw
                .split_once(" @@")
                .map(|(_, s)| s.trim().to_string())
                .unwrap_or_default();
            diff.hunks.push(DiffHunk {
                header,
                old_start: old,
                new_start: new,
                lines: Vec::new(),
            });
            continue;
        }
        let Some(hunk) = diff.hunks.last_mut() else {
            continue;
        };
        let Some(marker) = raw.as_bytes().first() else {
            continue;
        };
        let (kind, old_no, new_no) = match marker {
            b'+' => {
                diff.added = diff.added.saturating_add(1);
                let n = new;
                new = new.saturating_add(1);
                ("add", None, Some(n))
            }
            b'-' => {
                diff.removed = diff.removed.saturating_add(1);
                let n = old;
                old = old.saturating_add(1);
                ("del", Some(n), None)
            }
            b' ' => {
                let (a, b) = (old, new);
                old = old.saturating_add(1);
                new = new.saturating_add(1);
                ("context", Some(a), Some(b))
            }
            _ => continue,
        };
        hunk.lines.push(DiffLine {
            kind: kind.into(),
            text: raw[1..].into(),
            old_no,
            new_no,
        });
    }
    diff
}
