# Tool-call fixtures

Real provider payloads, captured live on 2026-10-06, that the adapters'
tool-call extraction is tested against. Large strings are clipped to 1200
characters and arrays to four entries; nothing else is edited.

| File | Source | Version |
|---|---|---|
| `codex-app-server.jsonl` | `codex app-server` stdio frames, one `{label, frame}` per line. Labels: `command`, `command-fail`, `read-command`, `file-create`, `file-edit-multi`, `mcp-approved`, `web`, `subagents`. | codex-cli 0.159.2, gpt-6.1-sol |
| `opencode-v2-sse.jsonl` | `/event` SSE stream as kone's OpenCodeAdapter receives it, `session.*` events only, text deltas dropped. Labels: `shell`, `shell-fail`, `write`, `edit`, `read-search`, `fetch`. | opencode 2.0.16 |
| `antigravity-post-tool-hook.jsonl` | Raw PostToolUse hook stdin, before kone's sanitizer. Note: carries no tool output. | agy 1.3.0 |
| `antigravity-stream-json.jsonl` | `agy -p --output-format stream-json` for the same run. Carries `tool_info.output`. | agy 1.3.0 |
| `antigravity-transcript.jsonl` | The run's `transcript_full.jsonl`; edit steps carry `[diff_block_start]` unified hunks. | agy 1.3.0 |

Facts these captures settled:

- Codex's code-mode `exec` wrapper never reaches app-server: the inner
  `commandExecution` / `mcpToolCall` / `fileChange` items arrive directly.
- A Codex command that prints quickly sends no `outputDelta`; its output is
  only in the completion's `aggregatedOutput`.
- Codex `commandActions` describes only part of a compound command
  (`echo x && ls -la` → one `listFiles` for `ls -la`).
- Codex `fileChange.changes[].diff` is the raw file content for `add`, and a
  headerless hunk for `update`. `webSearch.query` is empty until completion;
  `action.type` is `search` or `openPage`.
- OpenCode v2 carries the call's input on `session.tool.called.input`, an edit's
  patch on `session.tool.success.metadata.files[].patch`, and a command's exit
  code on `metadata.exit` (a non-zero exit is still `success`).

Cursor, Droid and Cline were not installed; their ACP fixtures elsewhere are
synthetic and do not establish real-provider coverage.
