//! Branch list for the Switch branch picker. Read-only.
use std::{path::Path, sync::atomic::AtomicBool, time::Instant};

/// One local or remote branch, as the picker lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub remote: bool,
    pub upstream: Option<String>,
}

const CAP: usize = 1024 * 1024;

pub(super) fn branches(path: &Path, cancel: &AtomicBool) -> Result<Vec<GitBranch>, String> {
    let deadline = Instant::now() + super::TIMEOUT;
    let Some(root) = super::root(path, deadline, cancel)? else {
        return Ok(Vec::new());
    };
    let out = crate::repo::read_git(
        &root,
        &[
            "for-each-ref",
            "--format=%(HEAD)%00%(upstream)%00%(refname)",
            "refs/heads",
            "refs/remotes",
        ],
        deadline,
        cancel,
        CAP,
        false,
    )?;
    Ok(parse(&String::from_utf8_lossy(&out)))
}

fn short_ref(full: &str) -> &str {
    full.strip_prefix("refs/heads/")
        .or_else(|| full.strip_prefix("refs/remotes/"))
        .unwrap_or(full)
}

/// Mirrors Electron's `branches()` in modules/git/history.ts.
pub(super) fn parse(out: &str) -> Vec<GitBranch> {
    out.lines()
        .filter_map(|line| {
            let mut parts = line.split('\0');
            let head = parts.next()?;
            let upstream = short_ref(parts.next().unwrap_or(""));
            let full = parts.next().unwrap_or("");
            let name = short_ref(full);
            // Skip the symbolic "origin/HEAD" pointer.
            if name.is_empty() || name.ends_with("/HEAD") {
                return None;
            }
            Some(GitBranch {
                name: name.to_string(),
                current: head == "*",
                remote: full.starts_with("refs/remotes/"),
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
            })
        })
        .collect()
}

/// Local branches, current first, then remote branches with no local
/// counterpart. Mirrors Electron's `branchPickerOptions`.
pub fn picker_options(all: Vec<GitBranch>) -> Vec<GitBranch> {
    let (mut local, remote): (Vec<_>, Vec<_>) = all.into_iter().partition(|b| !b.remote);
    let remote: Vec<_> = remote
        .into_iter()
        .filter(|b| {
            let bare = b.name.split_once('/').map_or(b.name.as_str(), |(_, rest)| rest);
            !local.iter().any(|l| l.name == bare || l.upstream.as_deref() == Some(b.name.as_str()))
        })
        .collect();
    local.sort_by_key(|b| !b.current);
    local.extend(remote);
    local
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(name: &str, current: bool, remote: bool, upstream: Option<&str>) -> GitBranch {
        GitBranch { name: name.into(), current, remote, upstream: upstream.map(Into::into) }
    }

    #[test]
    fn parses_for_each_ref_and_skips_remote_head() {
        let out = " \0\0refs/heads/feature/login\n*\0refs/remotes/origin/main\0refs/heads/main\n \0\0refs/remotes/origin/HEAD\n \0\0refs/remotes/origin/main\n";
        assert_eq!(
            parse(out),
            vec![
                b("feature/login", false, false, None),
                b("main", true, false, Some("origin/main")),
                b("origin/main", false, true, None),
            ]
        );
    }

    #[test]
    fn options_put_current_first_and_drop_shadowed_remotes() {
        let all = vec![
            b("feature/login", false, false, None),
            b("main", true, false, Some("origin/main")),
            b("origin/main", false, true, None),
            b("origin/feature/login", false, true, None),
            b("origin/wip", false, true, None),
        ];
        let names: Vec<_> = picker_options(all).into_iter().map(|b| b.name).collect();
        assert_eq!(names, ["main", "feature/login", "origin/wip"]);
    }
}
