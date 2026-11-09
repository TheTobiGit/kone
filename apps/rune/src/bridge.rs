use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const MAX_FRAME: usize = 64 * 1024 * 1024;

/// Supervises the local JSON-RPC process without doing pipe I/O on the UI thread.
pub struct Bridge {
    child: Option<Child>,
    outgoing: Option<SyncSender<Vec<u8>>>,
    incoming: Receiver<Value>,
    next_id: u64,
}

fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Value>> {
    let mut frame = Vec::new();
    let count = Read::take(reader, MAX_FRAME as u64 + 1).read_until(b'\n', &mut frame)?;
    if count == 0 {
        return Ok(None);
    }
    if count > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "sidecar frame exceeds 64 MiB",
        ));
    }
    serde_json::from_slice(&frame)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

impl Bridge {
    pub fn start(
        command: &str,
        args: &[&str],
        data_dir: &Path,
        wake: rune::Waker,
    ) -> io::Result<Self> {
        let mut child = Command::new(command)
            .args(args)
            .env("KONE_RUNE_DATA_DIR", data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let Some(mut input) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("sidecar stdin missing"));
        };
        let Some(output) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("sidecar stdout missing"));
        };
        let Some(errors) = child.stderr.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("sidecar stderr missing"));
        };
        let (sender, incoming) = mpsc::sync_channel(64);
        let (outgoing, writes) = mpsc::sync_channel::<Vec<u8>>(8);
        let write_sender = sender.clone();
        let write_wake = wake.clone();
        thread::spawn(move || {
            for frame in writes {
                if let Err(error) = input.write_all(&frame).and_then(|_| input.flush()) {
                    let _ = write_sender.send(
                        json!({"method":"sidecar.exited","params":{"error":error.to_string()}}),
                    );
                    write_wake();
                    return;
                }
            }
        });
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            let error = loop {
                match read_frame(&mut reader) {
                    Ok(Some(message)) => {
                        if sender.send(message).is_err() {
                            return;
                        }
                        wake();
                    }
                    Ok(None) => break None,
                    Err(error) => break Some(error.to_string()),
                }
            };
            let _ = sender.send(json!({"method":"sidecar.exited","params":{"error":error}}));
            wake();
        });
        thread::spawn(move || {
            for line in BufReader::new(errors).lines().map_while(Result::ok) {
                eprintln!("sidecar: {line}");
            }
        });
        Ok(Self {
            child: Some(child),
            outgoing: Some(outgoing),
            incoming,
            next_id: 1,
        })
    }

    pub fn request(&mut self, method: &str, params: Value) -> io::Result<u64> {
        let id = self.next_id;
        let mut frame =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        frame.push(b'\n');
        if frame.len() > MAX_FRAME {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "request exceeds 64 MiB",
            ));
        }
        let writer = self
            .outgoing
            .as_ref()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "sidecar is closed"))?;
        writer.try_send(frame).map_err(|error| match error {
            mpsc::TrySendError::Full(_) => io::Error::new(
                io::ErrorKind::WouldBlock,
                "sidecar request queue is full; try again",
            ),
            mpsc::TrySendError::Disconnected(_) => {
                io::Error::new(io::ErrorKind::BrokenPipe, "sidecar writer disconnected")
            }
        })?;
        self.next_id += 1;
        Ok(id)
    }

    pub fn try_recv(&self) -> Option<Value> {
        self.incoming.try_recv().ok()
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.outgoing.take();
        if let Some(mut child) = self.child.take() {
            thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(3);
                loop {
                    match child.try_wait() {
                        Ok(Some(_)) => return,
                        Err(_) => break,
                        Ok(None) => {}
                    }
                    if Instant::now() >= deadline {
                        break;
                    }
                    thread::sleep(Duration::from_millis(25));
                }
                let _ = child.kill();
                let _ = child.wait();
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_reads_keep_adjacent_frames_separate() {
        let bytes = b"{\"id\":1}\n{\"id\":2}\n";
        let mut reader = BufReader::with_capacity(2, bytes.as_slice());
        assert_eq!(read_frame(&mut reader).unwrap().unwrap()["id"], 1);
        assert_eq!(read_frame(&mut reader).unwrap().unwrap()["id"], 2);
        assert!(read_frame(&mut reader).unwrap().is_none());
    }
    #[test]
    fn malformed_frames_are_reported() {
        let mut reader = BufReader::new(b"{broken}\n".as_slice());
        assert_eq!(
            read_frame(&mut reader).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
