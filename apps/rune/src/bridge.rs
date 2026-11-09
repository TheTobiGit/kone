use std::io::{self, BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::thread;

use serde_json::{Value, json};

/// Owns the sidecar and delivers its messages to Rune's next poll.
pub struct Bridge {
    child: Child,
    input: ChildStdin,
    incoming: Receiver<Value>,
    next_id: AtomicU64,
}

impl Bridge {
    pub fn start(command: &str, args: &[&str], data_dir: &Path, wake: rune::Waker) -> io::Result<Self> {
        let mut child = Command::new(command)
            .args(args)
            .env("KONE_RUNE_DATA_DIR", data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let input = child.stdin.take().ok_or_else(|| io::Error::other("sidecar stdin missing"))?;
        let output = child.stdout.take().ok_or_else(|| io::Error::other("sidecar stdout missing"))?;
        let errors = child.stderr.take().ok_or_else(|| io::Error::other("sidecar stderr missing"))?;
        let (sender, incoming) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                match line {
                    Ok(line) => match serde_json::from_str::<Value>(&line) {
                        Ok(message) => { if sender.send(message).is_err() { return; } wake(); }
                        Err(error) => eprintln!("sidecar invalid message: {error}"),
                    },
                    Err(error) => { eprintln!("sidecar output: {error}"); break; }
                }
            }
            let _ = sender.send(json!({"method": "sidecar.exited", "params": {}}));
            wake();
        });
        thread::spawn(move || {
            for line in BufReader::new(errors).lines().map_while(Result::ok) {
                eprintln!("sidecar: {line}");
            }
        });
        Ok(Self { child, input, incoming, next_id: AtomicU64::new(1) })
    }

    pub fn request(&mut self, method: &str, params: Value) -> io::Result<u64> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        serde_json::to_writer(&mut self.input, &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;
        self.input.write_all(b"\n")?;
        self.input.flush()?;
        Ok(id)
    }

    pub fn try_recv(&self) -> Option<Value> {
        self.incoming.try_recv().ok()
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        // Closing the pipe lets the sidecar stop provider sessions before exit.
        // ChildStdin closes after this drop method returns.
        if let Ok(Some(_)) = self.child.try_wait() { return; }
        // Do not wait on the UI thread: the process exits when stdin closes.
    }
}
