import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { RuntimeEvent } from "./types.js";

class DatabaseSyncShim {
  private readonly db: Database;
  constructor(filePath: string, options?: { readOnly?: boolean }) {
    this.db = options?.readOnly
      ? new Database(filePath, { readonly: true })
      : new Database(filePath);
  }
  prepare(sql: string) {
    return this.db.prepare(sql);
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
  close() {
    this.db.close();
  }
}
mock.module("node:sqlite", () => ({ DatabaseSync: DatabaseSyncShim }));
mock.module("./sqlite.js", () => ({ DatabaseSync: DatabaseSyncShim }));

import {
  ANTGRAVITY_BINARY,
  parseAntigravityVersion,
  resolveAntigravityBinary,
} from "./antigravityHome.js";
import {
  AntigravityAdapter,
  antigravityPromptCommandLineIssue,
  antigravityTurnOutcome,
  buildKoneCaptureCommand,
  buildKoneHookConfig,
  hookScriptSource,
  parseAntigravityCliModelLabel,
  parseAntigravityModelLines,
  readCompleteAntigravityLines,
  resolveAntigravityCliModelLabel,
  summarizeAntigravityTool,
} from "./adapters/AntigravityAdapter.js";

// The adapter's parsing helpers are exercised directly, with no CLI spawn:
// each helper is the same one the adapter runs live, and the shapes it
// asserts were captured from the real CLI's output.

const noopEmit = () => {};

/** A temp home so the mode-gate tests never touch the machine's ~/.gemini. */
const TEST_HOME = mkdtempSync(path.join(tmpdir(), "kone-antigravity-home-"));
afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function runCaptureCommand(command: string, input: string, env: NodeJS.ProcessEnv) {
  const shell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  return spawnSync(shell, args, {
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
    timeout: 5_000,
  });
}

describe("Antigravity CLI model translation", () => {
  test("collapses CLI model/effort labels into base models with effort ladders", () => {
    expect(
      parseAntigravityModelLines(`
Gemini 3.5 Flash (Medium)
Gemini 3.5 Flash (High)
Gemini 3.5 Flash (Low)
Gemini 3.1 Pro (Low)
Gemini 3.1 Pro (High)
Claude Sonnet 4.6 (Thinking)
Claude Opus 4.6 (Thinking)
GPT-OSS 120B (Medium)
`),
    ).toEqual([
      {
        id: "Gemini 3.5 Flash",
        label: "Gemini 3.5 Flash",
        contextWindowTokens: 1_000_000,
        reasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "Gemini 3.1 Pro",
        label: "Gemini 3.1 Pro",
        contextWindowTokens: 1_000_000,
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
      },
      {
        id: "Claude Sonnet 4.6",
        label: "Claude Sonnet 4.6",
        contextWindowTokens: 200_000,
        reasoningEfforts: ["thinking"],
        defaultReasoningEffort: "thinking",
      },
      {
        id: "Claude Opus 4.6",
        label: "Claude Opus 4.6",
        contextWindowTokens: 200_000,
        reasoningEfforts: ["thinking"],
        defaultReasoningEffort: "thinking",
      },
      {
        id: "GPT-OSS 120B",
        label: "GPT-OSS 120B",
        contextWindowTokens: 128_000,
        reasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
      },
    ]);
  });

  test("collapses tab-separated slug/label rows from newer agy models output", () => {
    expect(
      parseAntigravityModelLines(`
gemini-3.6-flash-high\tGemini 3.6 Flash (High)
gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)
gemini-3.6-flash-low\tGemini 3.6 Flash (Low)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
`),
    ).toEqual([
      {
        id: "Gemini 3.6 Flash",
        label: "Gemini 3.6 Flash",
        contextWindowTokens: 1_000_000,
        reasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "Gemini 3.1 Pro",
        label: "Gemini 3.1 Pro",
        contextWindowTokens: 1_000_000,
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
      },
      {
        id: "Claude Sonnet 4.6",
        label: "Claude Sonnet 4.6",
        contextWindowTokens: 200_000,
        reasoningEfforts: ["thinking"],
        defaultReasoningEffort: "thinking",
      },
    ]);
  });

  test("rebuilds the exact CLI model label only at dispatch", () => {
    expect(parseAntigravityCliModelLabel("Gemini 3.5 Flash (High)")).toEqual({
      model: "Gemini 3.5 Flash",
      effort: "high",
    });
    expect(parseAntigravityCliModelLabel("gemini-3.6-flash-high\tGemini 3.6 Flash (High)")).toEqual({
      model: "Gemini 3.6 Flash",
      effort: "high",
    });
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash")).toBe("Gemini 3.5 Flash (Medium)");
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash", { reasoningEffort: "high" })).toBe(
      "Gemini 3.5 Flash (High)",
    );
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash (Low)")).toBe("Gemini 3.5 Flash (Low)");
    expect(resolveAntigravityCliModelLabel("gemini-3.6-flash-high\tGemini 3.6 Flash (High)")).toBe(
      "Gemini 3.6 Flash (High)",
    );
  });

  test("accepts bullet-prefixed model output", () => {
    expect(parseAntigravityCliModelLabel("* Gemini 3.5 Flash (High)")).toEqual({
      model: "Gemini 3.5 Flash",
      effort: "high",
    });
    expect(parseAntigravityCliModelLabel("• Claude Sonnet 4.6 (Thinking)")).toEqual({
      model: "Claude Sonnet 4.6",
      effort: "thinking",
    });
  });

  test("discovers future CLI models without requiring a static catalog update", () => {
    expect(
      parseAntigravityModelLines(`
Gemini 4 Pro (Low)
Gemini 4 Pro (Ultra)
Claude Sonnet 5 (Thinking)
`),
    ).toEqual([
      {
        id: "Gemini 4 Pro",
        label: "Gemini 4 Pro",
        contextWindowTokens: 1_000_000,
        reasoningEfforts: ["low", "ultra"],
        defaultReasoningEffort: "low",
      },
      {
        id: "Claude Sonnet 5",
        label: "Claude Sonnet 5",
        contextWindowTokens: 200_000,
        reasoningEfforts: ["thinking"],
        defaultReasoningEffort: "thinking",
      },
    ]);
  });

  test("dispatches a discovered model with its discovered default effort", () => {
    expect(resolveAntigravityCliModelLabel("Gemini 4 Pro", undefined, "low")).toBe(
      "Gemini 4 Pro (Low)",
    );
  });
});

describe("Antigravity install detection", () => {
  test("falls back to `agy` for a blank override, keeps a real path", () => {
    expect(resolveAntigravityBinary(undefined)).toBe(ANTGRAVITY_BINARY);
    expect(resolveAntigravityBinary("  ")).toBe(ANTGRAVITY_BINARY);
    expect(resolveAntigravityBinary("/opt/homebrew/bin/agy")).toBe("/opt/homebrew/bin/agy");
  });

  test("reads the bare semver from --version output", () => {
    expect(parseAntigravityVersion("1.0.12\n")).toBe("1.0.12");
    expect(parseAntigravityVersion("agy 1.0.12 (build 2026-07-01)\n")).toBe("1.0.12");
  });
});

describe("Antigravity capture plugin", () => {
  test("keeps the globally installed hook neutral outside kone sessions", () => {
    // PreToolUse must carry a `decision` — an empty object is treated as a
    // denial with an empty reason that blocks every tool call. PreInvocation
    // is the same kind of veto point over the model call it precedes, so an
    // empty object there refuses a subagent launch and exits the parent.
    const preToolResult = runCaptureCommand(
      buildKoneCaptureCommand("__kone_gui_must_not_launch__", "__capture_script_must_not_run__", "pre-tool"),
      JSON.stringify({ payload: "x".repeat(32 * 1024) }),
      { KONE_ANTIGRAVITY_EVENTS: "" },
    );
    expect(preToolResult.error).toBeUndefined();
    expect(preToolResult.status).toBe(0);
    expect(preToolResult.stdout.trim()).toBe('{"decision":"ask"}');

    const preInvocationResult = runCaptureCommand(
      buildKoneCaptureCommand("__kone_gui_must_not_launch__", "__capture_script_must_not_run__", "pre-invocation"),
      JSON.stringify({ payload: "x" }),
      { KONE_ANTIGRAVITY_EVENTS: "" },
    );
    expect(preInvocationResult.error).toBeUndefined();
    expect(preInvocationResult.status).toBe(0);
    expect(preInvocationResult.stdout.trim()).toBe('{"decision":"allow"}');

    const postToolResult = runCaptureCommand(
      buildKoneCaptureCommand("__kone_gui_must_not_launch__", "__capture_script_must_not_run__", "post-tool"),
      JSON.stringify({ payload: "x" }),
      { KONE_ANTIGRAVITY_EVENTS: "" },
    );
    expect(postToolResult.error).toBeUndefined();
    expect(postToolResult.status).toBe(0);
    expect(postToolResult.stdout.trim()).toBe("{}");
  });

  test("answers pre-tool with a decision from the capture script when capture is inactive", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "kone-antigravity-hook-test-"));
    try {
      const scriptPath = path.join(directory, "capture.cjs");
      writeFileSync(scriptPath, hookScriptSource(), { mode: 0o700 });
      const result = spawnSync(process.execPath, [scriptPath, "pre-tool"], {
        env: { ...process.env, KONE_ANTIGRAVITY_EVENTS: "" },
        input: JSON.stringify({ tool: "shell" }),
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('{"decision":"ask"}');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("answers pre-invocation allow from the capture script when capture is inactive", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "kone-antigravity-hook-test-"));
    try {
      const scriptPath = path.join(directory, "capture.cjs");
      writeFileSync(scriptPath, hookScriptSource(), { mode: 0o700 });
      const result = spawnSync(process.execPath, [scriptPath, "pre-invocation"], {
        env: { ...process.env, KONE_ANTIGRAVITY_EVENTS: "" },
        input: JSON.stringify({ conversationId: "conversation-1" }),
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('{"decision":"allow"}');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("runs the capture script for kone-managed sessions and captures tool args", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "kone-antigravity-hook-test-"));
    const scriptPath = path.join(directory, "capture.cjs");
    const eventPath = path.join(directory, "events.ndjson");
    try {
      writeFileSync(scriptPath, hookScriptSource(), { mode: 0o700 });
      const command = buildKoneCaptureCommand(process.execPath, scriptPath, "pre-tool");
      const result = runCaptureCommand(
        command,
        JSON.stringify({
          stepIdx: 12,
          conversationId: "conversation-1",
          transcriptPath: "/tmp/transcript.jsonl",
          toolCall: { name: "run_command", args: { CommandLine: "bun test" } },
        }),
        { KONE_ANTIGRAVITY_EVENTS: eventPath, KONE_ANTIGRAVITY_HOOK_DECISION: "allow" },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('{"decision":"allow"}');
      const captured = readFileSync(eventPath, "utf8");
      expect(captured).toBe(
        'pre-tool\t{"conversationId":"conversation-1","transcriptPath":"/tmp/transcript.jsonl","stepIdx":12,"toolCall":{"name":"run_command","args":{"CommandLine":"bun test"}}}\n',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("summarizeAntigravityTool extracts human-readable target text and details", () => {
    expect(summarizeAntigravityTool("run_command", { CommandLine: "bun test" })).toEqual({
      text: "bun test",
      detail: '{\n  "CommandLine": "bun test"\n}',
    });
    expect(
      summarizeAntigravityTool("view_file", { AbsolutePath: "/path/to/file.ts", toolAction: "Viewing file" }),
    ).toEqual({
      text: "/path/to/file.ts",
      detail: '{\n  "AbsolutePath": "/path/to/file.ts",\n  "toolAction": "Viewing file"\n}',
    });
    expect(
      summarizeAntigravityTool("write_to_file", { TargetFile: "/path/to/file.ts" }),
    ).toEqual({
      text: "/path/to/file.ts",
      detail: '{\n  "TargetFile": "/path/to/file.ts"\n}',
    });
    expect(
      summarizeAntigravityTool("replace_file_content", { TargetFile: "/path/to/file.ts" }),
    ).toEqual({
      text: "/path/to/file.ts",
      detail: '{\n  "TargetFile": "/path/to/file.ts"\n}',
    });
    expect(
      summarizeAntigravityTool("manage_task", { Action: "kill", TaskId: "task-19" }),
    ).toEqual({
      text: "kill task-19",
      detail: '{\n  "Action": "kill",\n  "TaskId": "task-19"\n}',
    });
    expect(
      summarizeAntigravityTool("grep_search", { Query: "antigravity" }),
    ).toEqual({
      text: "antigravity",
      detail: '{\n  "Query": "antigravity"\n}',
    });
    expect(
      summarizeAntigravityTool("find_by_name", { Pattern: "*.ts" }),
    ).toEqual({
      text: "*.ts",
      detail: '{\n  "Pattern": "*.ts"\n}',
    });
    expect(summarizeAntigravityTool("run_command", {})).toEqual({ text: "" });
    expect(summarizeAntigravityTool("run_command", undefined)).toEqual({ text: "" });
    // When text matches tool name, it returns empty string
    expect(summarizeAntigravityTool("run_command", { command: "run_command" })).toEqual({
      text: "",
      detail: '{\n  "command": "run_command"\n}',
    });
  });

  test("answers pre-invocation allow for kone-managed sessions so subagent launches survive", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "kone-antigravity-hook-test-"));
    const scriptPath = path.join(directory, "capture.cjs");
    const eventPath = path.join(directory, "events.ndjson");
    try {
      writeFileSync(scriptPath, hookScriptSource(), { mode: 0o700 });
      const result = runCaptureCommand(
        buildKoneCaptureCommand(process.execPath, scriptPath, "pre-invocation"),
        JSON.stringify({ stepIdx: 3, conversationId: "conversation-1" }),
        { KONE_ANTIGRAVITY_EVENTS: eventPath },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('{"decision":"allow"}');
      const captured = readFileSync(eventPath, "utf8");
      expect(captured).toBe('pre-invocation\t{"stepIdx":3,"conversationId":"conversation-1"}\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps the windows wrapper invocation free of double quotes", () => {
    // The CLI passes hook commands to cmd.exe with serialization escapes
    // undecoded, so any `"` around paths derails quote parsing and the hook
    // never runs; the fallback JSON itself is the only quoted content allowed.
    const command = buildKoneCaptureCommand("C:\\electron.exe", "C:\\capture.cjs", "pre-invocation", "win32");
    expect(command).toContain("(set ELECTRON_RUN_AS_NODE=1&& C:\\electron.exe C:\\capture.cjs pre-invocation)");
    expect(command).toContain('echo {"decision":"allow"}');
    expect(command).not.toContain('"C:\\');

    const posix = buildKoneCaptureCommand("/opt/electron", "/opt/capture.cjs", "pre-invocation", "darwin");
    expect(posix).toContain("printf '%s\\n' '{\"decision\":\"allow\"}'");
  });

  test("marks every generated hook as a command hook", () => {
    expect(buildKoneHookConfig((event) => `capture ${event}`)).toEqual({
      "kone-capture": {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "capture pre-tool" }],
          },
        ],
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "capture post-tool" }],
          },
        ],
        PreInvocation: [{ type: "command", command: "capture pre-invocation" }],
        PostInvocation: [{ type: "command", command: "capture post-invocation" }],
        Stop: [{ type: "command", command: "capture stop" }],
      },
    });
  });
});

describe("Antigravity turn guards", () => {
  test("rejects every interaction mode but full access", async () => {
    const adapter = new AntigravityAdapter(noopEmit, undefined, { homeDir: TEST_HOME });
    await expect(
      adapter.startSession({ threadId: "t1", provider: "antigravity", cwd: "/tmp", mode: "ask" }),
    ).rejects.toThrow(/Full access/);
    await expect(
      adapter.startSession({ threadId: "t1", provider: "antigravity", cwd: "/tmp", mode: "accept-edits" }),
    ).rejects.toThrow(/Full access/);
    // Full access passes the mode gate; the plugin install that follows is
    // best-effort (a missing CLI degrades with a warning, never a throw), so
    // the session resolves. Use a fake binary so the machine's real ~/.gemini
    // is never touched.
    const resolved = await new AntigravityAdapter(noopEmit, undefined, {
      homeDir: TEST_HOME,
    }).startSession({
      threadId: "t2",
      provider: "antigravity",
      cwd: "/tmp",
      mode: "full-access",
    });
    expect(resolved.mode).toBe("full-access");
  });

  test("guards Windows command-line limits before spawning the CLI", () => {
    expect(antigravityPromptCommandLineIssue("x".repeat(24_000), "win32")).toBeNull();
    expect(antigravityPromptCommandLineIssue("x".repeat(24_001), "win32")).toContain(
      "limited to 24,000 characters",
    );
    expect(antigravityPromptCommandLineIssue("x".repeat(120_000), "darwin")).toBeNull();
  });

  test("advances file offsets only past complete JSONL records", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "kone-antigravity-test-"));
    const file = path.join(directory, "events.ndjson");
    try {
      writeFileSync(file, '{"first":true}\n{"second"');
      const first = await readCompleteAntigravityLines(file, 0);
      expect(first).toEqual({ lines: ['{"first":true}'], nextOffset: 15 });

      writeFileSync(file, '{"first":true}\n{"second":true}\n');
      const second = await readCompleteAntigravityLines(file, first.nextOffset);
      expect(second).toEqual({ lines: ['{"second":true}'], nextOffset: 31 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects sendTurn when both prompt and attachments are empty", async () => {
    const adapter = new AntigravityAdapter(noopEmit, undefined, { homeDir: TEST_HOME });
    await adapter.startSession({
      threadId: "t-empty",
      provider: "antigravity",
      cwd: "/tmp",
      mode: "full-access",
    });
    await expect(
      adapter.sendTurn({ threadId: "t-empty", input: "" }),
    ).rejects.toThrow("A prompt or file attachment is required.");
  });

  test("accepts image attachments in sendTurn and includes them in the prompt", async () => {
    const { getAttachmentStore, resetAttachmentStoreForTests } = await import("./AttachmentStore.js");
    const { getConversationStore, resetConversationStoreForTests } = await import("./ConversationStore.js");
    const { setUserDataDir } = await import("./userDataDir.js");

    const attTmpDir = mkdtempSync(path.join(tmpdir(), "kone-antigravity-att-"));
    setUserDataDir(attTmpDir);
    try {
      getConversationStore().ensureThread({
        threadId: "t-image",
        projectPath: "/tmp",
        provider: "antigravity",
      });
      const adapter = new AntigravityAdapter(noopEmit, undefined, {
        homeDir: TEST_HOME,
        // Use a dummy binary path so process spawning fails after prompt assembly
        resolveBinary: () => "/bin/echo",
      });
      await adapter.startSession({
        threadId: "t-image",
        provider: "antigravity",
        cwd: "/tmp",
        mode: "full-access",
      });

      const store = getAttachmentStore();
      const img = await store.save({
        threadId: "t-image",
        name: "screenshot.png",
        mimeType: "image/png",
        data: Buffer.from("png-bytes").toString("base64"),
      });

      // Sending a turn with empty input but a valid image attachment must pass prompt validation
      // and start the turn
      const result = await adapter.sendTurn({
        threadId: "t-image",
        input: "",
        attachments: [img],
      });
      expect(result.turnId).toBeDefined();
      expect(result.turnId.startsWith("antigravity-turn-")).toBe(true);
    } finally {
      resetAttachmentStoreForTests();
      resetConversationStoreForTests();
      rmSync(attTmpDir, { recursive: true, force: true });
    }
  });
});



/** A stand-in for `agy -p` that replays a scripted print-mode turn: it writes
 *  the transcripts and the capture-hook stream a real turn produces, in two
 *  stages, then waits to be torn down. Stage one ends with the agent going
 *  quiet while its subagent is still working — the moment the adapter must not
 *  mistake for the end of the turn. */
function writeScriptedAntigravityCli(dir: string): string {
  const scriptPath = path.join(dir, "agy-scripted.sh");
  const script = `#!/bin/sh
EV="$KONE_ANTIGRAVITY_EVENTS"
# Not a turn (the plugin-install probe runs the same binary): nothing to replay.
[ -n "$EV" ] || exit 0
RUN=$(dirname "$EV")
PARENT="$RUN/parent.jsonl"
CHILD="$RUN/child.jsonl"

cat > "$PARENT" <<'PARENT_EOF'
{"step_index":0,"type":"USER_INPUT","content":"go"}
{"step_index":2,"type":"PLANNER_RESPONSE","content":"Spawning a worker.","tool_calls":[{"name":"invoke_subagent","args":{"Subagents":"[{\\"Role\\":\\"Test Worker\\",\\"TypeName\\":\\"research\\",\\"Prompt\\":\\"Check the tests.\\",\\"Model\\":\\"inherit\\"}]"}}]}
PARENT_EOF
cat >> "$PARENT" <<CREATED_EOF
{"step_index":3,"type":"GENERIC","content":"Created the following subagents:\\n{\\n  \\"conversationId\\": \\"child-1\\",\\n  \\"logAbsoluteUri\\": \\"file://$CHILD\\"\\n}"}
CREATED_EOF

printf 'pre-invocation\t{"conversationId":"parent-1","transcriptPath":"%s"}\n' "$PARENT" >> "$EV"
printf 'pre-tool\t{"conversationId":"parent-1","transcriptPath":"%s","toolCall":{"name":"invoke_subagent"},"stepIdx":3}\n' "$PARENT" >> "$EV"
printf 'post-tool\t{"conversationId":"parent-1","stepIdx":3}\n' >> "$EV"
printf 'stop\t{"conversationId":"parent-1","fullyIdle":false}\n' >> "$EV"

sleep 1

cat > "$CHILD" <<'CHILD_EOF'
{"step_index":0,"type":"USER_INPUT","content":"Check the tests."}
{"step_index":2,"type":"PLANNER_RESPONSE","content":"Listing the directory.","tool_calls":[{"name":"list_dir"}]}
{"step_index":4,"type":"PLANNER_RESPONSE","content":"Done. Every test passes."}
CHILD_EOF
printf 'pre-invocation\t{"conversationId":"child-1"}\n' >> "$EV"
printf 'pre-tool\t{"conversationId":"child-1","toolCall":{"name":"list_dir"},"stepIdx":3}\n' >> "$EV"
printf 'post-tool\t{"conversationId":"child-1","stepIdx":3}\n' >> "$EV"
printf 'stop\t{"conversationId":"child-1","fullyIdle":true}\n' >> "$EV"

cat >> "$PARENT" <<'REPORT_EOF'
{"step_index":5,"type":"SYSTEM_MESSAGE","content":"<SYSTEM_MESSAGE>\\n[Message] sender=child-1 priority=MESSAGE_PRIORITY_HIGH content=Every test passes.\\n</SYSTEM_MESSAGE>"}
{"step_index":6,"type":"PLANNER_RESPONSE","content":"The worker reports that every test passes."}
REPORT_EOF
printf 'stop\t{"conversationId":"parent-1","fullyIdle":true}\n' >> "$EV"

sleep 30
`;
  writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

async function waitForEvent(
  events: RuntimeEvent[],
  match: (event: RuntimeEvent) => boolean,
  timeoutMs = 15_000,
): Promise<RuntimeEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error("timed out waiting for event");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("Antigravity native subagents", () => {
  test("surfaces a native subagent run without losing the parent conversation", async () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "kone-antigravity-sub-"));
    const events: RuntimeEvent[] = [];
    const adapter = new AntigravityAdapter((event) => events.push(event), undefined, {
      homeDir: TEST_HOME,
      resolveBinary: () => writeScriptedAntigravityCli(runDir),
    });
    try {
      await adapter.startSession({
        threadId: "t-sub",
        provider: "antigravity",
        cwd: runDir,
        mode: "full-access",
      });
      await adapter.sendTurn({ threadId: "t-sub", input: "go" });

      const completed = await waitForEvent(events, (event) => event.type === "turn.completed");

      // The regression: a child's hook lines carry the child's conversation id,
      // and adopting one as the session's would repoint the thread at the
      // subagent — wrong resume id, wrong transcript.
      expect(completed.type === "turn.completed" && completed.conversationId).toBe("parent-1");

      const started = events.find((event) => event.type === "subagent.started");
      expect(started?.type === "subagent.started" && started.subagent).toMatchObject({
        toolUseId: "child-1",
        agentType: "research",
        description: "Test Worker",
        prompt: "Check the tests.",
        status: "running",
        background: true,
      });
      // The run hangs off the tool call that spawned it.
      const spawnItem = events.find(
        (event) => event.type === "item.started" && event.item.name === "invoke_subagent",
      );
      expect(started?.type === "subagent.started" && started.subagent.parentItemId).toBe(
        spawnItem?.type === "item.started" ? spawnItem.item.itemId : undefined,
      );

      // The child's own work, attributed to the child and not to the parent.
      const childItems = events.filter(
        (event) =>
          (event.type === "item.started" || event.type === "item.completed") &&
          event.subagentToolUseId === "child-1",
      );
      expect(childItems.some((event) => "item" in event && event.item.name === "list_dir")).toBe(true);
      expect(
        childItems.some((event) => "item" in event && event.item.text === "Done. Every test passes."),
      ).toBe(true);

      // Two settlements are normal: the child goes idle on the hook stream, and
      // its report arrives in the parent transcript a beat later. The last one
      // is the run as it ends up.
      const settled = events.filter((event) => event.type === "subagent.completed").at(-1);
      expect(settled?.type === "subagent.completed" && settled.subagent.status).toBe("completed");
      expect(settled?.type === "subagent.completed" && settled.subagent.summary).toBe(
        "Every test passes.",
      );
      expect(settled?.type === "subagent.completed" && settled.subagent.lastToolName).toBe("list_dir");

      // The parent's own reply — written after the child reported, so it only
      // exists here because the turn was still alive to see it.
      expect(
        events.some(
          (event) =>
            event.type === "item.completed" &&
            event.subagentToolUseId === undefined &&
            event.item.text === "The worker reports that every test passes.",
        ),
      ).toBe(true);
    } finally {
      await adapter.stopSession("t-sub");
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("Antigravity token usage emission", () => {
  function varint(value: number): number[] {
    const out: number[] = [];
    let v = BigInt(value);
    while (v > 0x7fn) {
      out.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    out.push(Number(v));
    return out;
  }
  function key(field: number, wireType: number): number[] {
    return varint((field << 3) | wireType);
  }
  function fieldVarint(field: number, value: number): number[] {
    return [...key(field, 0), ...varint(value)];
  }
  function fieldBytes(field: number, bytes: Uint8Array): number[] {
    return [...key(field, 2), ...varint(bytes.length), ...bytes];
  }
  function encodeMessage(fields: number[][]): Uint8Array {
    return Uint8Array.from(fields.flat());
  }
  function genMetadataRow(chatFields: number[][]): Uint8Array {
    return encodeMessage([fieldBytes(1, encodeMessage(chatFields))]);
  }
  function usageMessage(input: number, output: number, thinking: number, responseId: string): number[][] {
    return [
      fieldVarint(2, input),
      fieldVarint(3, output),
      fieldVarint(9, Math.max(0, output - thinking)),
      fieldVarint(10, thinking),
      fieldBytes(11, new TextEncoder().encode(responseId)),
    ];
  }
  function chatMessage(usage: number[][]): number[][] {
    return [
      fieldBytes(4, encodeMessage(usage)),
      fieldBytes(21, new TextEncoder().encode("Gemini 3.5 Flash (High)")),
    ];
  }

  test("emits thread.token-usage.updated on turn completion and on session resume", async () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "kone-antigravity-usage-"));
    const conversationsDir = path.join(TEST_HOME, ".gemini", "antigravity-cli", "conversations");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(conversationsDir, { recursive: true });

    // Seed conversation database for conv-123
    const dbPath = path.join(conversationsDir, "conv-123.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
    const insert = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
    insert.run(0, genMetadataRow(chatMessage(usageMessage(1200, 450, 150, "resp-1"))));
    db.close();

    const scriptPath = path.join(runDir, "agy-usage.sh");
    const script = `#!/bin/sh
EV="$KONE_ANTIGRAVITY_EVENTS"
[ -n "$EV" ] || exit 0
printf 'pre-invocation\t{"conversationId":"conv-123"}\n' >> "$EV"
printf 'stop\t{"conversationId":"conv-123","fullyIdle":true}\n' >> "$EV"
`;
    writeFileSync(scriptPath, script, { mode: 0o755 });

    const events: RuntimeEvent[] = [];
    const adapter = new AntigravityAdapter((event) => events.push(event), undefined, {
      homeDir: TEST_HOME,
      resolveBinary: () => scriptPath,
    });

    try {
      await adapter.startSession({
        threadId: "t-usage",
        provider: "antigravity",
        cwd: runDir,
        mode: "full-access",
      });
      await adapter.sendTurn({ threadId: "t-usage", input: "hello" });

      await waitForEvent(events, (event) => event.type === "turn.completed");

      const usageEvents = events.filter((e) => e.type === "thread.token-usage.updated");
      expect(usageEvents.length).toBeGreaterThan(0);
      const lastUsage = usageEvents.at(-1);
      expect(lastUsage?.type === "thread.token-usage.updated" && lastUsage.usage).toEqual({
        input: 1200,
        output: 450,
        total: 1650,
        contextWindow: 1_000_000,
        contextUsed: 1650,
        compactsAutomatically: true,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 150,
      });

      // Resume test: a new session starting with resume: "conv-123" emits usage right away
      const resumeEvents: RuntimeEvent[] = [];
      const resumeAdapter = new AntigravityAdapter((event) => resumeEvents.push(event), undefined, {
        homeDir: TEST_HOME,
        resolveBinary: () => scriptPath,
      });
      await resumeAdapter.startSession({
        threadId: "t-resume",
        provider: "antigravity",
        cwd: runDir,
        mode: "full-access",
        resume: "conv-123",
      });

      const resumeUsage = resumeEvents.find((e) => e.type === "thread.token-usage.updated");
      expect(resumeUsage).toBeDefined();
      expect(resumeUsage?.type === "thread.token-usage.updated" && resumeUsage.usage.total).toBe(1650);

      await resumeAdapter.stopSession("t-resume");
    } finally {
      await adapter.stopSession("t-usage");
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe("antigravityTurnOutcome", () => {
  const outcome = (over: Partial<Parameters<typeof antigravityTurnOutcome>[0]>) =>
    antigravityTurnOutcome({
      interrupted: false,
      agentStopped: false,
      code: 0,
      signal: null,
      ...over,
    });

  test("a clean exit completes the turn", () => {
    expect(outcome({})).toBe("completed");
  });

  test("a non-zero exit with no Stop behind it fails the turn", () => {
    expect(outcome({ code: 1 })).toBe("failed");
    expect(outcome({ code: null })).toBe("failed");
  });

  test("a signalled exit with no Stop behind it reads as interrupted", () => {
    expect(outcome({ code: null, signal: "SIGKILL" })).toBe("interrupted");
  });

  test("the user's interrupt wins over everything", () => {
    expect(outcome({ interrupted: true, agentStopped: true, code: 1 })).toBe("interrupted");
  });

  // The regression: a turn that leaves a background subagent running keeps
  // print mode waiting, the Stop-hook teardown kills it, and the CLI exits
  // non-zero after printing its wait timeout. The turn still completed.
  test("a non-zero exit after the Stop hook completes the turn", () => {
    expect(outcome({ agentStopped: true, code: 1 })).toBe("completed");
  });

  test("the teardown escalating to SIGKILL still completes the turn", () => {
    expect(outcome({ agentStopped: true, code: null, signal: "SIGKILL" })).toBe("completed");
  });
});
