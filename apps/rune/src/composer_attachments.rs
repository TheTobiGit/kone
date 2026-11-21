//! Composer attachments, after Electron's `useComposerAttachments.ts`: files picked or dropped
//! onto the composer ride the next request. They upload through `agent.uploadAttachment` once
//! the request is sent, and the turn carries the bytes-free metadata the uploads return.

use std::path::{Path, PathBuf};

use base64::Engine as _;

use crate::state::AppState;

pub const MAX_ATTACHMENTS: usize = 8;
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
const NOTICE_SECS: f32 = 3.2;

#[derive(Clone, Debug, PartialEq)]
pub struct PendingAttachment {
    pub id: u64,
    pub path: PathBuf,
    pub name: String,
    pub mime_type: String,
    pub image: bool,
    pub size_bytes: u64,
    /// A short uppercase badge, e.g. "PDF", "MD".
    pub ext: String,
}

/// The request waiting on its uploads: its text, and the transcript bubble it already shows.
#[derive(Clone, Debug, Default)]
pub struct UploadTurn {
    pub input: String,
    pub item: Option<String>,
    pub requests: Vec<u64>,
    pub uploaded: Vec<(u64, serde_json::Value)>,
}

pub fn ext_badge(name: &str) -> String {
    let raw = match name.rfind('.') {
        Some(dot) if dot > 0 => &name[dot + 1..],
        _ => "",
    };
    let raw = if raw.is_empty() { "FILE" } else { raw };
    raw.chars().take(4).collect::<String>().to_uppercase()
}

pub fn mime_type_for(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "zip" => "application/zip",
        "csv" => "text/csv",
        "md" | "markdown" => "text/markdown",
        "html" | "htm" => "text/html",
        "txt" | "log" => "text/plain",
        _ => "application/octet-stream",
    }
}

impl AppState {
    pub fn add_attachments(&mut self, paths: &[PathBuf]) {
        let mut added = 0;
        for path in paths {
            if self.studio.attachments.len() >= MAX_ATTACHMENTS {
                self.attachment_notice(format!("Up to {MAX_ATTACHMENTS} attachments per message."));
                break;
            }
            let Ok(meta) = std::fs::metadata(path) else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "attachment".into());
            let mime_type = mime_type_for(&name);
            let image = mime_type.starts_with("image/");
            let cap = if image {
                MAX_IMAGE_BYTES
            } else {
                MAX_FILE_BYTES
            };
            if meta.len() > cap {
                let mb = cap / (1024 * 1024);
                self.attachment_notice(format!("\"{name}\" is too large (max {mb} MB)."));
                continue;
            }
            self.studio.attachment_seq += 1;
            self.studio.attachments.push(PendingAttachment {
                id: self.studio.attachment_seq,
                path: path.clone(),
                ext: ext_badge(&name),
                name,
                mime_type: mime_type.into(),
                image,
                size_bytes: meta.len(),
            });
            added += 1;
        }
        if added > 0 && !self.studio.composer_open {
            self.open_composer();
        }
    }

    pub fn remove_attachment(&mut self, id: u64) {
        self.studio.attachments.retain(|a| a.id != id);
    }

    pub fn pick_attachment(&mut self, tx: &mut rune::Tx) {
        let options = rune::FileDialogOptions {
            title: "Attach a file".into(),
            ..Default::default()
        };
        tx.open_file(options, |s: &mut AppState, result, _| match result {
            Ok(Some(path)) => s.add_attachments(&[path]),
            Ok(None) => {}
            Err(error) => s.attachment_notice(error.to_string()),
        });
    }

    fn attachment_notice(&mut self, message: String) {
        self.studio.attachment_notice = Some((message, std::time::Instant::now()));
    }

    /// Clears a notice once it has shown for its time; true when it did.
    pub fn expire_attachment_notice(&mut self, tx: &mut rune::Tx) -> bool {
        let Some((_, at)) = &self.studio.attachment_notice else {
            return false;
        };
        let left = NOTICE_SECS - at.elapsed().as_secs_f32();
        if left > 0.0 {
            tx.wake_after(std::time::Duration::from_secs_f32(left));
            return false;
        }
        self.studio.attachment_notice = None;
        true
    }

    /// Uploads the request's files, then sends it once every upload has answered. A file that
    /// can't be read or uploaded is dropped rather than sinking the whole send, like Electron.
    pub(crate) fn upload_then_send(
        &mut self,
        input: String,
        item: Option<String>,
        files: Vec<PendingAttachment>,
    ) {
        let mut turn = UploadTurn {
            input,
            item,
            ..Default::default()
        };
        for file in files {
            let bytes = match std::fs::read(&file.path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    self.attachment_notice(format!("Could not read \"{}\": {error}", file.name));
                    continue;
                }
            };
            let data = base64::engine::general_purpose::STANDARD.encode(bytes);
            let params = serde_json::json!({
                "threadId": self.studio.thread_id,
                "name": file.name,
                "mimeType": file.mime_type,
                "data": data,
            });
            if let Some(id) = self.request("agent.uploadAttachment", params) {
                turn.requests.push(id);
            }
        }
        self.studio.upload_turn = Some(turn);
        self.finish_uploads_if_done();
    }

    /// Takes the reply to an upload; true when `id` was one.
    pub(crate) fn upload_reply(&mut self, id: u64, message: &serde_json::Value) -> bool {
        let Some(turn) = self.studio.upload_turn.as_mut() else {
            return false;
        };
        let Some(index) = turn.requests.iter().position(|r| *r == id) else {
            return false;
        };
        turn.requests.remove(index);
        if message["result"]["id"].is_string() {
            // Request ids rise in pick order; keep that order however the replies land.
            let at = turn.uploaded.partition_point(|(sent, _)| *sent < id);
            turn.uploaded.insert(at, (id, message["result"].clone()));
        } else {
            let error = message["error"]["message"]
                .as_str()
                .unwrap_or("Could not attach a file.")
                .to_owned();
            self.attachment_notice(error);
        }
        self.finish_uploads_if_done();
        true
    }

    fn finish_uploads_if_done(&mut self) {
        if self
            .studio
            .upload_turn
            .as_ref()
            .is_none_or(|turn| !turn.requests.is_empty())
        {
            return;
        }
        let Some(turn) = self.studio.upload_turn.take() else {
            return;
        };
        if turn.input.is_empty() && turn.uploaded.is_empty() {
            // Nothing is left to send: take back the request this send put on screen.
            if let Some(item) = turn.item {
                self.studio.items.retain(|i| i.id != item);
                self.studio.busy = false;
            }
            return;
        }
        self.studio.turn_attachments = turn.uploaded.into_iter().map(|(_, a)| a).collect();
        self.continue_studio_send(turn.input);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(dir: &Path, name: &str, len: usize) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, vec![b'x'; len]).unwrap();
        path
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kone-attach-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn badges_and_mime_types_follow_the_file_name() {
        assert_eq!(ext_badge("notes.md"), "MD");
        assert_eq!(ext_badge("archive.tar.gzip"), "GZIP");
        assert_eq!(ext_badge("Makefile"), "FILE");
        assert_eq!(ext_badge(".env"), "FILE");
        assert_eq!(mime_type_for("Shot.PNG"), "image/png");
        assert_eq!(mime_type_for("spec.pdf"), "application/pdf");
        assert_eq!(mime_type_for("blob"), "application/octet-stream");
    }

    #[test]
    fn adding_files_enforces_electrons_count_and_size_caps() {
        let dir = scratch("caps");
        let mut s = AppState::default();
        let small = fixture(&dir, "a.txt", 3);
        s.add_attachments(&[small.clone(), dir.clone()]);
        assert_eq!(s.studio.attachments.len(), 1, "a folder is not attached");
        assert!(s.studio.composer_open, "attaching wakes the composer");
        assert_eq!(s.studio.attachments[0].ext, "TXT");

        let big = dir.join("huge.png");
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        s.add_attachments(&[big]);
        assert_eq!(s.studio.attachments.len(), 1);
        assert_eq!(
            s.studio.attachment_notice.as_ref().map(|n| n.0.as_str()),
            Some("\"huge.png\" is too large (max 10 MB).")
        );

        let many: Vec<_> = (0..10).map(|_| small.clone()).collect();
        s.add_attachments(&many);
        assert_eq!(s.studio.attachments.len(), MAX_ATTACHMENTS);
        assert_eq!(
            s.studio.attachment_notice.as_ref().map(|n| n.0.as_str()),
            Some("Up to 8 attachments per message.")
        );
        let id = s.studio.attachments[0].id;
        s.remove_attachment(id);
        assert_eq!(s.studio.attachments.len(), MAX_ATTACHMENTS - 1);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_turn_waits_for_its_uploads_and_carries_the_ones_that_landed() {
        let mut s = AppState::default();
        s.studio.thread_id = "t".into();
        s.studio.started = true;
        s.studio.busy = true;
        s.studio.upload_turn = Some(UploadTurn {
            input: "see attached".into(),
            item: None,
            requests: vec![7, 8],
            uploaded: Vec::new(),
        });
        let ok = json!({"id":7,"result":{"type":"file","id":"att_1","name":"a.txt","mimeType":"text/plain","sizeBytes":3}});
        assert!(s.upload_reply(7, &ok));
        assert!(
            s.studio.upload_turn.is_some(),
            "still waiting on the second upload"
        );
        assert!(!s.upload_reply(99, &ok));
        let failed = json!({"id":8,"error":{"message":"Attachment is empty."}});
        assert!(s.upload_reply(8, &failed));
        assert!(s.studio.upload_turn.is_none());
        assert_eq!(
            s.studio.attachment_notice.as_ref().map(|n| n.0.as_str()),
            Some("Attachment is empty.")
        );
        // No sidecar in tests: the send reached `request`, which reports it, and the
        // attachments it carried were taken.
        assert_eq!(
            s.studio.error.as_deref(),
            Some("Agent service is unavailable")
        );
        assert!(s.studio.turn_attachments.is_empty());
    }

    #[test]
    fn uploads_keep_the_order_they_were_picked_in() {
        let mut s = AppState::default();
        s.studio.upload_turn = Some(UploadTurn {
            input: "x".into(),
            requests: vec![4, 5, 6],
            ..Default::default()
        });
        let reply = |id: u64| json!({"id":id,"result":{"type":"file","id":format!("att_{id}"),"name":"f","mimeType":"text/plain","sizeBytes":1}});
        assert!(s.upload_reply(6, &reply(6)));
        assert!(s.upload_reply(4, &reply(4)));
        let order: Vec<u64> = s
            .studio
            .upload_turn
            .as_ref()
            .unwrap()
            .uploaded
            .iter()
            .map(|(id, _)| *id)
            .collect();
        assert_eq!(order, [4, 6]);
    }

    #[test]
    fn an_attachment_only_request_whose_uploads_all_fail_is_withdrawn() {
        let mut s = AppState::default();
        s.studio.busy = true;
        s.studio.items.push(crate::state::StudioItem {
            id: "user-0".into(),
            kind: "user".into(),
            ..Default::default()
        });
        s.studio.upload_turn = Some(UploadTurn {
            input: String::new(),
            item: Some("user-0".into()),
            requests: vec![3],
            uploaded: Vec::new(),
        });
        assert!(s.upload_reply(3, &json!({"id":3,"error":{"message":"nope"}})));
        assert!(s.studio.items.is_empty() && !s.studio.busy);
    }
}
