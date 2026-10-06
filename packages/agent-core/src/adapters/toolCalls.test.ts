import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ToolCallAccumulator } from "../toolCallAccumulator.js";
import { acpObservation, codexCommandView, describeTool, openCodeFileChanges, unwrapShellCommand } from "./toolCalls.js";
import { normalizeV2Event } from "./opencodeV2Events.js";
import { record, type OpenCodeEvent, type RecordLike } from "./opencodeJson.js";
import { diffStats } from "@kone/protocol/unified-diff";

describe("captured OpenCode tool events", () => {
  test("v2 translation retains command input, exit status and per-file patches", () => {
    const state = { messageRoleById: new Map<string, string>(), partById: new Map<string, RecordLike>() };
    const captures = readFileSync(path.join(import.meta.dir, "fixtures/toolCalls/opencode-v2-sse.jsonl"), "utf8")
       .trim().split("\n").map((line) => {
        // SAFETY: repository-owned SSE fixtures use label/event envelopes with decoded JSON event data.
        return JSON.parse(line) as { label: string; event: { type: string; data?: OpenCodeEvent["properties"] } };
      });
    let commands = 0; let patches = 0; let failures = 0;
    for (const capture of captures) {
      const normalized = normalizeV2Event(state, { type: capture.event.type, properties: capture.event.data });
      const part = record(normalized.properties?.part);
      if (!part || part.type !== "tool") continue;
      state.partById.set(String(part.id), part);
      const toolState = record(part.state);
      const metadata = record(toolState?.metadata);
      if (toolState?.status !== "completed") continue;
      const tool = describeTool(String(part.tool), toolState.input);
      if (capture.label === "shell" || capture.label === "shell-fail") {
        expect(tool.input).toBeDefined();
        if (tool.action === "run") { expect(tool.target).toBeDefined(); commands++; }
        if (metadata?.exit === 1) failures++;
      }
      const changes = openCodeFileChanges(metadata, true);
      if (changes?.length) {
        expect(changes[0]).toMatchObject({ path: "notes.txt", applied: true });
        expect(changes[0]?.diff).toContain("-beta\n+BETA");
        patches++;
      }
    }
    expect(commands).toBeGreaterThan(0);
    expect(failures).toBeGreaterThan(0);
    expect(patches).toBeGreaterThan(0);
  });
});

describe("synthetic ACP observations (protocol coverage only)", () => {
  test("a status-free title update preserves an explicit command and terminal failure", () => {
    const state = new ToolCallAccumulator();
    state.observe(acpObservation({ kind: "execute", rawInput: { command: "false" }, status: "failed" }, "run", "exit 1"));
    state.observe(acpObservation({ title: "Done" }, undefined, ""));
    expect(state.snapshot()).toMatchObject({ name: "run", text: "false", detail: "exit 1", status: "failed", tool: { action: "run", title: "Done" } });
  });

  test("MCP transport does not determine semantic action", () => {
    expect(describeTool("mcp__files__read_file", { path: "a.ts" })).toMatchObject({
      action: "read", target: "a.ts", transport: { server: "files", tool: "read_file" },
    });
  });
});

test("an ACP before/after block becomes a real line diff, not a whole-file replace", () => {
  const before = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 250", "LINE 250");
  const observation = acpObservation(
    { toolCallId: "c1", kind: "edit", status: "completed", content: [{ type: "diff", path: "/w/a.ts", oldText: before, newText: after }] },
    "edit_file",
    "",
  );
  const [change] = observation.fileChanges!;
  expect(change).toMatchObject({ path: "/w/a.ts", kind: "edited", applied: true });
  expect(diffStats(change!.diff)).toEqual({ added: 1, removed: 1 });
});

describe("shell wrappers", () => {
  test("only the exact quoted login-shell shape unwraps", () => {
    expect(unwrapShellCommand("/bin/bash -lc 'git status --short'")).toBe("git status --short");
    expect(unwrapShellCommand("bash -c 'echo it'\\''s'")).toBe("echo it's");
    expect(unwrapShellCommand('/bin/zsh -lc "echo \\"hi\\" \\$HOME"')).toBe('echo "hi" $HOME');
    expect(unwrapShellCommand("/usr/bin/sh -c 'ls'")).toBe("ls");
    // Anything else is shown as it ran.
    expect(unwrapShellCommand("/bin/bash -lc 'a' 'b'")).toBe("/bin/bash -lc 'a' 'b'");
    expect(unwrapShellCommand("/bin/bash -lc 'a' | tee x")).toBe("/bin/bash -lc 'a' | tee x");
    expect(unwrapShellCommand("/bin/fish -c 'ls'")).toBe("/bin/fish -c 'ls'");
    expect(unwrapShellCommand("git status")).toBe("git status");
  });
});

describe("captured Codex commands", () => {
  const completed = readFileSync(path.join(import.meta.dir, "fixtures/toolCalls/codex-app-server.jsonl"), "utf8")
    .trim().split("\n")
    // SAFETY: repository-owned app-server fixtures use label/frame envelopes of decoded JSON-RPC frames.
    .map((line) => JSON.parse(line) as { label: string; frame: { method?: string; params?: { item?: { type?: string } } } })
    .filter(({ frame }) => frame.method === "item/completed" && frame.params?.item?.type === "commandExecution");
  const view = (label: string) => codexCommandView(completed.find((c) => c.label === label)!.frame.params!.item!);

  test("a compound script stays a run, unwrapped", () => {
    expect(view("command")).toMatchObject({ action: "run", target: "echo capture-ok && ls -la" });
  });

  test("a whole-script read reads as a read of its path", () => {
    expect(view("read-command")).toMatchObject({ action: "read", target: "/etc/hostname" });
    expect(view("command-fail")).toMatchObject({ action: "read", target: "/nonexistent/file.txt" });
  });

  test("the executed command and cwd stay in the input", () => {
    expect(JSON.parse(view("command")!.input)).toEqual({ command: "/bin/bash -lc 'echo capture-ok && ls -la'", cwd: "/tmp/kone-capture/work" });
  });
});
