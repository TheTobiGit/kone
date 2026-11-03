use super::*;
use std::{
    collections::HashMap,
    path::Path,
    sync::atomic::AtomicBool,
    time::{Instant, UNIX_EPOCH},
};
const STATUS_CAP: usize = 8 * 1024 * 1024;

pub(super) fn snapshot(path: &Path, cancel: &AtomicBool) -> Result<Option<GitSnapshot>, String> {
    let deadline = Instant::now() + TIMEOUT;
    let Some(root) = root(path, deadline, cancel)? else {
        return Ok(None);
    };
    let out = crate::repo::read_git(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "-z",
        ],
        deadline,
        cancel,
        STATUS_CAP,
        false,
    )?;
    let mut snapshot = parse_status(&out)?;
    snapshot.root = root.to_str().ok_or("Repository path is not UTF-8")?.into();
    let args = if snapshot.head.is_some() {
        vec![
            "diff",
            "--numstat",
            "-z",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "HEAD",
            "--",
        ]
    } else {
        vec![
            "diff",
            "--numstat",
            "-z",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--cached",
            "--",
        ]
    };
    let counts = parse_counts(&crate::repo::read_git(
        &root, &args, deadline, cancel, STATUS_CAP, false,
    )?)?;
    let mut bytes_read = 0usize;
    for change in &mut snapshot.changes {
        check(deadline, cancel)?;
        let full = safe_path(&root, &change.path)?;
        if change.status == "untracked" {
            let content = read_file(&full)?;
            if let Some(text) = content.text {
                bytes_read = bytes_read.saturating_add(text.len());
                if bytes_read > 32 * 1024 * 1024 {
                    return Err("Untracked line-count budget exceeded".into());
                }
                change.added = text.lines().count().min(u32::MAX as usize) as u32;
            }
        } else if let Some((added, removed)) = counts.get(&change.path) {
            change.added = *added;
            change.removed = *removed;
        }
        change.modified_at = std::fs::symlink_metadata(&full)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|t| t.as_secs_f64() * 1000.);
    }
    check(deadline, cancel)?;
    Ok(Some(snapshot))
}
fn text(bytes: &[u8]) -> Result<String, String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| "Git paths must be UTF-8".into())
}
fn parse_counts(out: &[u8]) -> Result<HashMap<String, (u32, u32)>, String> {
    if out
        .split(|&b| b == 0)
        .filter(|r| !r.is_empty())
        .any(|r| r.splitn(3, |&b| b == b'\t').count() != 3)
    {
        return Err("Invalid numstat".into());
    }
    crate::repo::parse_numstat(out)
        .into_iter()
        .map(|(path, counts)| Ok((text(&path)?, counts)))
        .collect()
}
fn parse_status(out: &[u8]) -> Result<GitSnapshot, String> {
    let mut snapshot = GitSnapshot::default();
    let mut records = out.split(|&b| b == 0);
    while let Some(row) = records.next() {
        if row.is_empty() {
            continue;
        }
        if row.starts_with(b"# ") {
            let header = text(row)?;
            if let Some(v) = header.strip_prefix("# branch.oid ") {
                snapshot.head = (v != "(initial)").then(|| v.chars().take(7).collect());
            }
            if let Some(v) = header.strip_prefix("# branch.head ") {
                snapshot.detached = v == "(detached)";
                snapshot.branch = (!snapshot.detached).then(|| v.into());
            }
            if let Some(v) = header.strip_prefix("# branch.ab ") {
                let mut parts = v.split_whitespace();
                snapshot.ahead = parts
                    .next()
                    .and_then(|s| s.strip_prefix('+'))
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                snapshot.behind = parts
                    .next()
                    .and_then(|s| s.strip_prefix('-'))
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
            }
            continue;
        }
        let kind = row[0];
        if kind == b'!' {
            continue;
        }
        if kind == b'?' {
            snapshot.changes.push(GitChange {
                path: text(&row[2..])?,
                status: "untracked".into(),
                unstaged: true,
                ..Default::default()
            });
            continue;
        }
        let fields: Vec<_> = row
            .splitn(
                match kind {
                    b'1' => 9,
                    b'2' => 10,
                    b'u' => 11,
                    _ => return Err("Unsupported git status record".into()),
                },
                |&b| b == b' ',
            )
            .collect();
        let xy = fields
            .get(1)
            .filter(|s| s.len() == 2)
            .ok_or("Invalid git status flags")?;
        let code = if xy[1] != b'.' { xy[1] } else { xy[0] };
        let status = if kind == b'u' {
            "conflicted"
        } else {
            match code {
                b'A' => "added",
                b'D' => "deleted",
                b'R' => "renamed",
                b'C' => "copied",
                b'T' => "type-changed",
                _ => "modified",
            }
        };
        let from = if kind == b'2' {
            Some(text(records.next().ok_or("Missing rename origin")?)?)
        } else {
            None
        };
        snapshot.changes.push(GitChange {
            path: text(fields.last().ok_or("Missing status path")?)?,
            from,
            status: status.into(),
            staged: kind != b'u' && xy[0] != b'.',
            unstaged: kind == b'u' || xy[1] != b'.',
            ..Default::default()
        });
    }
    snapshot.clean = snapshot.changes.is_empty();
    Ok(snapshot)
}
