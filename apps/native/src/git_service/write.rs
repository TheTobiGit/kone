//! Serialized repository mutations, using the shared bounded git runner.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak, atomic::AtomicBool},
    time::{Duration, Instant},
};

/// A literal branch name: never accept checkout's special previous-branch syntax.
pub fn valid_branch_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && name != "@"
        && name != "HEAD"
        && !name.contains("..")
        && !name.contains("@{")
        && !name
            .bytes()
            .any(|b| b <= b' ' || b == 127 || b"~^:?*[\\".contains(&b))
        && name.split('/').all(|part| {
            !part.is_empty()
                && !part.starts_with('.')
                && !part.ends_with('.')
                && !part.ends_with(".lock")
        })
}

fn mutation_lock(root: PathBuf) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&root).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(root, Arc::downgrade(&lock));
    lock
}

pub(super) fn create_branch(path: &Path, name: &str, cancel: &AtomicBool) -> Result<(), String> {
    if !valid_branch_name(name) {
        return Err("Invalid branch name".into());
    }
    let deadline = Instant::now() + super::TIMEOUT;
    let root = super::root(path, deadline, cancel)?.ok_or("Not a git repository")?;
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let lock = mutation_lock(root.clone());
    // Waiting is bounded and cancellable too; unrelated repositories never wait.
    let _guard = loop {
        super::check(deadline, cancel)?;
        match lock.try_lock() {
            Ok(guard) => break guard,
            Err(std::sync::TryLockError::Poisoned(error)) => break error.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(Duration::from_millis(10))
            }
        }
    };
    crate::repo::read_git(
        &root,
        &["switch", "-c", name],
        deadline,
        cancel,
        64 * 1024,
        false,
    )
    .map(|_| ())
    .map_err(|error| {
        error
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or(&error)
            .to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_literal_branch_names() {
        for name in [
            "", "-bad", "a..b", "a@{b", "a.lock", "a.lock/b", "a/", "a//b", ".a", "a/.b", "a./b",
            "a.", "a b", "a\t", "a\n", "a\u{7f}", "a~", "a^", "a:", "a?", "a*", "a[", "a\\", "@",
            "@{-1}", "/a", "HEAD",
        ] {
            assert!(!valid_branch_name(name), "{name:?}");
        }
        for name in [
            "main",
            "Main",
            "feature/search",
            "fix/ü",
            "a@b",
            "a.locked",
            "a/b-c_1",
        ] {
            assert!(valid_branch_name(name), "{name:?}");
        }
    }

    #[test]
    fn locks_share_roots_and_release_unused_entries() {
        let first = mutation_lock(PathBuf::from("one"));
        assert!(Arc::ptr_eq(&first, &mutation_lock(PathBuf::from("one"))));
        assert!(!Arc::ptr_eq(&first, &mutation_lock(PathBuf::from("two"))));
        let guard = first.lock().unwrap();
        assert!(mutation_lock(PathBuf::from("one")).try_lock().is_err());
        drop(guard);
    }
}
