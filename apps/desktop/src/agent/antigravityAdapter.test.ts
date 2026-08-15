import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  ANTGRAVITY_BINARY,
  parseAntigravityVersion,
  resolveAntigravityBinary,
} from "./antigravityHome.js";
import {
  AntigravityAdapter,
  antigravityPromptCommandLineIssue,
  buildKoneCaptureCommand,
  buildKoneHookConfig,
  hookScriptSource,
  parseAntigravityCliModelLabel,
  parseAntigravityModelLines,
  readCompleteAntigravityLines,
  resolveAntigravityCliModelLabel,
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
        reasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "Gemini 3.1 Pro",
        label: "Gemini 3.1 Pro",
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
      },
      {
        id: "Claude Sonnet 4.6",
        label: "Claude Sonnet 4.6",
        reasoningEfforts: ["thinking"],
        defaultReasoningEffort: "thinking",
      },
      {
        id: "Claude Opus 4.6",
        label: "Claude Opus 4.6",
        reasoningEfforts: ["thinking"],
        defaultReasoningEffort: "thinking",
      },
      {
        id: "GPT-OSS 120B",
        label: "GPT-OSS 120B",
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
        reasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "Gemini 3.1 Pro",
        label: "Gemini 3.1 Pro",
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
      },
      {
        id: "Claude Sonnet 4.6",
        label: "Claude Sonnet 4.6",
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
        reasoningEfforts: ["low", "ultra"],
        defaultReasoningEffort: "low",
      },
      {
        id: "Claude Sonnet 5",
        label: "Claude Sonnet 5",
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
    // denial with an empty reason that blocks every tool call.
    const preToolResult = runCaptureCommand(
      buildKoneCaptureCommand("__kone_gui_must_not_launch__", "__capture_script_must_not_run__", "pre-tool"),
      JSON.stringify({ payload: "x".repeat(32 * 1024) }),
      { KONE_ANTIGRAVITY_EVENTS: "" },
    );
    expect(preToolResult.error).toBeUndefined();
    expect(preToolResult.status).toBe(0);
    expect(preToolResult.stdout.trim()).toBe('{"decision":"ask"}');

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

  test("runs the capture script for kone-managed sessions and sanitizes tool args", () => {
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
          toolCall: { name: "run_command", args: { CommandLine: "echo super-secret-token" } },
        }),
        { KONE_ANTIGRAVITY_EVENTS: eventPath, KONE_ANTIGRAVITY_HOOK_DECISION: "allow" },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('{"decision":"allow"}');
      const captured = readFileSync(eventPath, "utf8");
      expect(captured).toBe(
        'pre-tool\t{"conversationId":"conversation-1","transcriptPath":"/tmp/transcript.jsonl","stepIdx":12,"toolCall":{"name":"run_command"}}\n',
      );
      expect(captured).not.toContain("super-secret-token");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
});

