//! The single replaceable boundary for view-only project git reads.
//! Implementations block only on GPUI's background executor. One cancellation
//! flag belongs to a project entity; leaving it terminates in-flight git groups.
mod detail;
mod status;
#[cfg(test)]
mod tests;
mod types;
use std::{path::Path, sync::atomic::AtomicBool};
pub use types::*;

pub trait GitService: Send + Sync {
    fn snapshot(&self, path: &Path, cancel: &AtomicBool) -> Result<Option<GitSnapshot>, String>;
    fn detail(
        &self,
        path: &Path,
        file: &str,
        staged: bool,
        cancel: &AtomicBool,
    ) -> Result<FileDetail, String>;
}
#[derive(Default)]
pub struct NativeGit;
impl GitService for NativeGit {
    fn snapshot(&self, path: &Path, cancel: &AtomicBool) -> Result<Option<GitSnapshot>, String> {
        status::snapshot(path, cancel)
    }
    fn detail(
        &self,
        path: &Path,
        file: &str,
        staged: bool,
        cancel: &AtomicBool,
    ) -> Result<FileDetail, String> {
        detail::detail(path, file, staged, cancel)
    }
}

const FILE_CAP: usize = 512 * 1024;
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
fn check(deadline: std::time::Instant, cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(std::sync::atomic::Ordering::Acquire) {
        return Err("Git read cancelled".into());
    }
    if std::time::Instant::now() >= deadline {
        return Err("Git read timed out".into());
    }
    Ok(())
}
fn root(
    path: &Path,
    deadline: std::time::Instant,
    cancel: &AtomicBool,
) -> Result<Option<std::path::PathBuf>, String> {
    std::fs::read_dir(path).map_err(|e| format!("Couldn't read project folder: {e}"))?;
    match crate::repo::read_git(
        path,
        &["rev-parse", "--show-toplevel"],
        deadline,
        cancel,
        FILE_CAP,
        false,
    ) {
        Ok(bytes) => Ok(Some(std::path::PathBuf::from(
            String::from_utf8(bytes)
                .map_err(|_| "Repository path is not UTF-8")?
                .trim_end_matches('\n'),
        ))),
        Err(error) if error.contains("not a git repository") => Ok(None),
        Err(error) => Err(error),
    }
}
/// Reject lexical escapes and symlinked parent directories. A final symlink
/// stays a symlink: callers never follow it into content outside the project.
fn safe_path(root: &Path, rel: &str) -> Result<std::path::PathBuf, String> {
    let path = Path::new(rel);
    if rel.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("Invalid repository path".into());
    }
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let full = root.join(path);
    let mut parent = full.parent();
    while let Some(dir) = parent {
        match std::fs::canonicalize(dir) {
            Ok(resolved) => {
                if !resolved.starts_with(&root) {
                    return Err("Path escapes repository".into());
                }
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => parent = dir.parent(),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(full)
}
fn read_file(path: &Path) -> Result<FileContent, String> {
    use std::io::Read;
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(FileContent::default()),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.is_file() {
        return Ok(FileContent::default());
    }
    if meta.len() > FILE_CAP as u64 {
        return Ok(FileContent {
            text: None,
            binary: false,
            truncated: true,
        });
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("File changed during preview".into());
    }
    let mut bytes = Vec::new();
    file.take(FILE_CAP as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let binary = bytes.contains(&0);
    let truncated = bytes.len() > FILE_CAP;
    Ok(FileContent {
        text: if binary || truncated {
            None
        } else {
            Some(String::from_utf8_lossy(&bytes).into_owned())
        },
        binary,
        truncated,
    })
}
