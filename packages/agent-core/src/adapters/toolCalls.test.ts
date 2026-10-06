import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ToolCallAccumulator } from "../toolCallAccumulator.js";
import { acpObservation, describeTool, openCodeFileChanges } from "./toolCalls.js";
import { normalizeV2Event } from "./opencodeV2Events.js";
import { record, type OpenCodeEvent, type RecordLike } from "./opencodeJson.js";

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
