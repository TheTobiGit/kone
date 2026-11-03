/// Complete working-tree data shared by all Overview surfaces.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GitSnapshot {
    pub root: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub head: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<GitChange>,
    pub clean: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct GitChange {
    pub path: String,
    pub from: Option<String>,
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub added: u32,
    pub removed: u32,
    pub modified_at: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct FileDiff {
    pub path: String,
    pub binary: bool,
    pub hunks: Vec<DiffHunk>,
    pub added: u32,
    pub removed: u32,
}

#[derive(Clone, Debug, Default)]
pub struct DiffHunk {
    pub header: String,
    pub old_start: u32,
    pub new_start: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Clone, Debug, Default)]
pub struct DiffLine {
    pub kind: String,
    pub text: String,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
}

#[derive(Clone, Debug, Default)]
pub struct FileContent {
    pub text: Option<String>,
    pub binary: bool,
    pub truncated: bool,
}

#[derive(Clone, Debug, Default)]
pub struct FileDetail {
    pub diff: Option<FileDiff>,
    pub content: Option<FileContent>,
    pub limited: bool,
}
