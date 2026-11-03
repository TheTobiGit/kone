//! Bounded command execution. Own the child until it is reaped; cancellation
//! terminates the whole Unix process group, including shell descendants.
use std::{
    io::{self, Read},
    process::{Command, Output, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, mpsc},
    time::{Duration, Instant},
};

pub fn output(cmd: &mut Command, limit: Duration, cancel: &AtomicBool, cap: usize) -> io::Result<Output> {
    if cancel.load(Ordering::Acquire) {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "Command cancelled"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let pid = child.id();
    let terminate = |child: &mut std::process::Child| {
        #[cfg(unix)]
        let _ = Command::new("/bin/kill").args(["-KILL", "--", &format!("-{pid}")]).status();
        #[cfg(windows)]
        let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).status();
        let _ = child.kill();
        let _ = child.wait();
    };
    let (send, recv) = mpsc::channel();
    fn drain(mut pipe: impl Read + Send + 'static, cap: usize, send: mpsc::Sender<(bool, io::Result<Vec<u8>>)>, stdout: bool) {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = (|| {
                let mut buffer = [0; 8192];
                loop {
                    let n = pipe.read(&mut buffer)?;
                    if n == 0 { break; }
                    bytes.extend_from_slice(&buffer[..n.min(cap.saturating_sub(bytes.len()))]);
                }
                Ok(bytes)
            })();
            let _ = send.send((stdout, result));
        });
    }
    drain(child.stdout.take().expect("piped stdout"), cap, send.clone(), true);
    drain(child.stderr.take().expect("piped stderr"), cap, send, false);
    let start = Instant::now();
    let (mut stdout, mut stderr, mut status) = (None, None, None);
    loop {
        let error = if cancel.load(Ordering::Acquire) {
            Some(io::Error::new(io::ErrorKind::Interrupted, "Command cancelled"))
        } else if start.elapsed() >= limit {
            Some(io::Error::new(io::ErrorKind::TimedOut, "Command timed out"))
        } else { None };
        if let Some(error) = error {
            terminate(&mut child);
            return Err(error);
        }
        match child.try_wait() {
            Ok(Some(value)) => status = Some(value),
            Ok(None) => {},
            Err(error) => { terminate(&mut child); return Err(error); }
        }
        while let Ok((is_stdout, result)) = recv.try_recv() {
            let bytes = match result {
                Ok(bytes) => bytes,
                Err(error) => { terminate(&mut child); return Err(error); }
            };
            if is_stdout { stdout = Some(bytes); } else { stderr = Some(bytes); }
        }
        if let (Some(status), Some(stdout), Some(stderr)) = (status, stdout.as_ref(), stderr.as_ref()) {
            return Ok(Output { status, stdout: stdout.clone(), stderr: stderr.clone() });
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use core::prelude::v1::test;

    #[test]
    fn deadline_kills_shell_descendants_holding_pipes() {
        let start = Instant::now();
        let error = output(Command::new("sh").args(["-c", "sleep 30 & wait"]), Duration::from_millis(100), &AtomicBool::new(false), 1024).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn cancellation_interrupts_a_running_command() {
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let task = std::thread::spawn(move || output(Command::new("sh").args(["-c", "sleep 30 & wait"]), Duration::from_secs(60), &signal, 1024));
        std::thread::sleep(Duration::from_millis(100));
        cancel.store(true, Ordering::Release);
        assert_eq!(task.join().unwrap().unwrap_err().kind(), io::ErrorKind::Interrupted);
    }

    #[test]
    fn drains_large_output_without_deadlock() {
        let out = output(Command::new("sh").args(["-c", "head -c 100000 /dev/zero; echo error >&2"]), Duration::from_secs(2), &AtomicBool::new(false), 100).unwrap();
        assert!(out.status.success());
        assert_eq!(out.stdout.len(), 100);
        assert_eq!(out.stderr, b"error\n");
    }
}

/// A shared, small worker bound for filesystem/git batches. Results retain
/// input order; the caller stays off the UI thread.
pub fn parallel_map<T: Sync, R: Send>(items: &[T], work: impl Fn(&T) -> R + Sync) -> Vec<R> {
    std::thread::scope(|scope| {
        let work = &work;
        let workers: Vec<_> = items.chunks(items.len().div_ceil(4).max(1))
            .map(|chunk| scope.spawn(move || chunk.iter().map(work).collect::<Vec<_>>()))
            .collect();
        workers.into_iter().flat_map(|worker| worker.join().expect("batch worker panicked")).collect()
    })
}
