//! The working-tree model behind the project overview.
//!
//! Electron keeps one `GitChange` per path (`useProjectGit`): a partially
//! staged file is one record with both `staged` and `unstaged` set, and its
//! line counts already span the whole working tree versus HEAD. The overview
//! still needs to draw that file in both lanes, so the model splits the
//! snapshot into `FileEntry` rows while deriving totals from the original,
//! path-unique changes. Counting the rows instead would bill a partial stage
//! twice.

use std::collections::HashSet;

use crate::git_service::{GitChange, GitSnapshot};

/// The two stacks the overview draws: what is in the index, and what is still
/// only in the working tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Lane {
    Staged,
    Changed,
}

impl Lane {
    fn prefix(self) -> &'static str {
        match self {
            Lane::Staged => "staged",
            Lane::Changed => "changed",
        }
    }
}

/// One row in a lane. A partially staged file appears once in each lane, so the
/// lane has to be part of the row's identity.
#[derive(Clone, Debug)]
pub struct FileEntry {
    pub change: GitChange,
    pub lane: Lane,
}

impl FileEntry {
    /// Stable identity across both lanes: the same change id means the same
    /// row, while a partial stage gets one key per lane.
    pub fn key(&self) -> String {
        format!("{}:{}", self.lane.prefix(), self.change.path)
    }

    /// Whether this row belongs to the staged lane. It deliberately reads the
    /// lane rather than `change.staged`: a partially staged file's working-tree
    /// row still has `change.staged` set, but it is not a staged row.
    pub fn staged(&self) -> bool {
        self.lane == Lane::Staged
    }
}

/// The overview's data, derived once from a snapshot so drawing never has to
/// re-count or re-sort.
#[derive(Clone, Debug)]
pub struct OverviewModel {
    pub snapshot: GitSnapshot,
    pub staged: Vec<FileEntry>,
    pub changed: Vec<FileEntry>,
    /// Unique changed paths, matching Electron's `changes.length`.
    pub file_count: usize,
    /// Whole-tree line totals over the unique paths, matching Electron's sum
    /// over `status.changes`.
    pub added: u32,
    pub removed: u32,
}

impl From<GitSnapshot> for OverviewModel {
    fn from(snapshot: GitSnapshot) -> Self {
        let mut staged = Vec::new();
        let mut changed = Vec::new();
        let mut seen = HashSet::new();
        let mut added = 0u32;
        let mut removed = 0u32;

        for change in &snapshot.changes {
            if is_ignored(change) {
                continue;
            }

            // Line counts cover the whole file (both index and working tree),
            // so each path contributes once; the lane rows below may repeat it.
            if seen.insert(change.path.as_str()) {
                added = added.saturating_add(change.added);
                removed = removed.saturating_add(change.removed);
            }

            if change.staged {
                staged.push(FileEntry { change: change.clone(), lane: Lane::Staged });
            }
            if change.unstaged || is_untracked(change) {
                changed.push(FileEntry { change: change.clone(), lane: Lane::Changed });
            }
        }

        sort_lane(&mut staged);
        sort_lane(&mut changed);

        let file_count = seen.len();
        Self { snapshot, staged, changed, file_count, added, removed }
    }
}

impl OverviewModel {
    pub fn entries(&self, lane: Lane) -> &[FileEntry] {
        match lane {
            Lane::Staged => &self.staged,
            Lane::Changed => &self.changed,
        }
    }

    /// Every row in drawing order: the index lane first, then the working tree.
    /// A partially staged file is intentionally present twice.
    pub fn all_entries(&self) -> Vec<FileEntry> {
        self.staged.iter().chain(&self.changed).cloned().collect()
    }
}

fn is_ignored(change: &GitChange) -> bool {
    change.status.eq_ignore_ascii_case("ignored")
}

fn is_untracked(change: &GitChange) -> bool {
    change.status.eq_ignore_ascii_case("untracked")
}

/// Most recently edited first. A deletion has no file to date, so it follows
/// every dated row; ties fall back to the path so refreshes don't reshuffle.
fn sort_lane(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        let by_time = match (dated(a), dated(b)) {
            (Some(a), Some(b)) => b.total_cmp(&a),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        };
        by_time.then_with(|| a.change.path.cmp(&b.change.path))
    });
}

/// A usable modification time. Non-finite values (a bad timestamp from the
/// wire) sort with the undated rows rather than poisoning the order.
fn dated(entry: &FileEntry) -> Option<f64> {
    entry.change.modified_at.filter(|at| at.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(path: &str, status: &str) -> GitChange {
        GitChange { path: path.into(), status: status.into(), ..GitChange::default() }
    }

    fn snapshot(changes: Vec<GitChange>) -> GitSnapshot {
        GitSnapshot { changes, ..GitSnapshot::default() }
    }

    fn at(mut change: GitChange, modified_at: f64) -> GitChange {
        change.modified_at = Some(modified_at);
        change
    }

    #[test]
    fn partial_stage_is_in_both_lanes_but_counted_once() {
        let mut file = change("src/lib.rs", "modified");
        file.staged = true;
        file.unstaged = true;
        file.added = 7;
        file.removed = 2;

        let model = OverviewModel::from(snapshot(vec![file]));

        assert_eq!(model.staged.len(), 1);
        assert_eq!(model.changed.len(), 1);
        assert_eq!(model.all_entries().len(), 2);
        assert_eq!(model.file_count, 1);
        assert_eq!((model.added, model.removed), (7, 2));

        let staged = &model.staged[0];
        let changed = &model.changed[0];
        assert_eq!(staged.lane, Lane::Staged);
        assert_eq!(changed.lane, Lane::Changed);
        assert!(staged.staged());
        assert!(!changed.staged());
        assert_ne!(staged.key(), changed.key());
        assert_eq!(staged.key(), "staged:src/lib.rs");
        assert_eq!(changed.key(), "changed:src/lib.rs");
    }

    #[test]
    fn duplicate_paths_do_not_inflate_the_cards() {
        let mut first = change("a.rs", "modified");
        first.staged = true;
        first.added = 4;
        first.removed = 1;
        let mut second = change("a.rs", "modified");
        second.unstaged = true;
        second.added = 4;
        second.removed = 1;

        let model = OverviewModel::from(snapshot(vec![first, second]));

        // Each record contributes to its own lane, but the file and its lines
        // are counted once.
        assert_eq!(model.staged.len(), 1);
        assert_eq!(model.changed.len(), 1);
        assert_eq!(model.file_count, 1);
        assert_eq!((model.added, model.removed), (4, 1));
    }

    #[test]
    fn lanes_lead_with_the_newest_edit_then_path() {
        let mut newest = change("z.rs", "modified");
        newest.unstaged = true;
        let mut older = change("a.rs", "modified");
        older.unstaged = true;
        let mut undated = change("m.rs", "deleted");
        undated.unstaged = true;

        let model = OverviewModel::from(snapshot(vec![undated, at(older, 10.0), at(newest, 30.0)]));
        let order: Vec<_> =
            model.changed.iter().map(|entry| entry.change.path.as_str()).collect();

        assert_eq!(order, ["z.rs", "a.rs", "m.rs"]);
    }

    #[test]
    fn dated_rows_precede_undated_ones_and_ties_use_the_path() {
        let mut b = change("b.rs", "modified");
        b.unstaged = true;
        b.modified_at = Some(20.0);
        let mut a = change("a.rs", "modified");
        a.unstaged = true;
        a.modified_at = Some(20.0);
        let mut newest = change("z.rs", "modified");
        newest.unstaged = true;
        newest.modified_at = Some(40.0);
        let mut gone = change("gone.rs", "deleted");
        gone.unstaged = true;

        let model = OverviewModel::from(snapshot(vec![b, gone, a, newest]));
        let order: Vec<_> =
            model.changed.iter().map(|entry| entry.change.path.as_str()).collect();

        assert_eq!(order, ["z.rs", "a.rs", "b.rs", "gone.rs"]);
    }

    #[test]
    fn ignored_rows_are_not_changes() {
        let mut ignored = change("target/debug/app", "ignored");
        ignored.staged = true;
        ignored.unstaged = true;
        ignored.added = 999;
        ignored.removed = 999;

        let model = OverviewModel::from(snapshot(vec![ignored]));

        assert!(model.staged.is_empty());
        assert!(model.changed.is_empty());
        assert_eq!(model.file_count, 0);
        assert_eq!((model.added, model.removed), (0, 0));
    }

    #[test]
    fn empty_untracked_file_still_makes_the_tree_dirty() {
        let untracked = change("notes/empty.txt", "untracked");

        let model = OverviewModel::from(snapshot(vec![untracked]));

        // No lines to show, but it is still a changed file in the working tree.
        assert!(model.staged.is_empty());
        assert_eq!(model.changed.len(), 1);
        assert!(!model.changed[0].staged());
        assert_eq!(model.file_count, 1);
        assert_eq!((model.added, model.removed), (0, 0));
    }

    #[test]
    fn entries_picks_the_lane_and_all_entries_lists_staged_first() {
        let mut staged = change("staged.rs", "added");
        staged.staged = true;
        let mut working = change("working.rs", "modified");
        working.unstaged = true;

        let model = OverviewModel::from(snapshot(vec![working, staged]));

        assert_eq!(model.entries(Lane::Staged)[0].change.path, "staged.rs");
        assert_eq!(model.entries(Lane::Changed)[0].change.path, "working.rs");
        let all = model.all_entries();
        assert_eq!(all[0].lane, Lane::Staged);
        assert_eq!(all[1].lane, Lane::Changed);
    }
}
