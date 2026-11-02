//! The wire boundary between the native shell and agent-core.
//!
//! agent-core stays TypeScript and runs as a child bun process; the shell
//! talks to it with JSON-RPC 2.0 over its stdio, one message per line. Only
//! the envelope and the first calls the launcher needs are defined so far —
//! nothing here spawns a process yet.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const JSONRPC: &str = "2.0";

#[derive(Debug, Serialize, Deserialize)]
pub struct Request {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub params: Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Response {
    pub jsonrpc: String,
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

/// A push from agent-core with no reply expected: turn deltas, git watches.
#[derive(Debug, Serialize, Deserialize)]
pub struct Notification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

/// What the launcher shows for one recent project.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileChange {
    Added,
    Modified,
    Deleted,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChangedFile {
    pub name: String,
    pub change: FileChange,
    pub added: u32,
    pub removed: u32,
}

/// A project's working-tree summary, the data a folder tile is drawn from.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RepoSummary {
    pub repo: bool,
    pub branch: Option<String>,
    pub added: u32,
    pub removed: u32,
    pub files: Vec<ChangedFile>,
}

/// The calls the shell will make first. Method names are the wire names.
pub mod method {
    pub const RECENTS_LIST: &str = "recents.list";
    pub const REPO_SUMMARY: &str = "git.summary";
}

impl Request {
    pub fn new(id: u64, method: &str, params: Value) -> Self {
        Request { jsonrpc: JSONRPC.into(), id, method: method.into(), params }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trips() {
        let r = Request::new(1, method::RECENTS_LIST, Value::Null);
        let s = serde_json::to_string(&r).unwrap();
        assert_eq!(s, r#"{"jsonrpc":"2.0","id":1,"method":"recents.list"}"#);
    }
}
