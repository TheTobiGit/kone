import { describe, expect, test } from "bun:test";
import type { RuntimeItem } from "../types/desktop";
import { canonicalizeItem, canonicalToolName } from "./toolName";

function toolCall(name: string, extra: Partial<RuntimeItem> = {}): RuntimeItem {
  return { itemId: "item-1", kind: "tool_call", status: "in-progress", text: "", name, ...extra };
}

describe("canonicalizeItem", () => {
  test("restamps a qualified tool_call with its canonical name", () => {
    expect(canonicalizeItem(toolCall("mcp__kone__worker_spawn_batch")).name).toBe("agent_spawn_batch");
    expect(canonicalizeItem(toolCall("kone__worker_spawn_batch")).name).toBe("agent_spawn_batch");
  });

  test("returns an already-canonical item by identity", () => {
    const item = toolCall("read_file");
    expect(canonicalizeItem(item)).toBe(item);
    const foreign = toolCall("mcp__github__fetch_pr");
    expect(canonicalizeItem(foreign)).toBe(foreign);
  });

  test("leaves non-tool items alone", () => {
    const text: RuntimeItem = {
      itemId: "item-2",
      kind: "assistant_text",
      status: "completed",
      text: "kone__worker_spawn_batch",
    };
    expect(canonicalizeItem(text)).toBe(text);
  });

  test("reaches into a nested subagent run", () => {
    const parent = toolCall("task", {
      subagent: {
        toolUseId: "use-1",
        startedAt: 0,
        status: "running",
        items: [toolCall("kone__worker_spawn_batch", { itemId: "child-1" })],
      },
    });
    const out = canonicalizeItem(parent);
    expect(out.subagent?.items[0]?.name).toBe("agent_spawn_batch");
    // The parent's own name needed no change, but the rebuild must not lose it.
    expect(out.name).toBe("task");
  });
});

describe("canonicalToolName", () => {
  test("unwraps each way a provider stamps the server", () => {
    expect(canonicalToolName("mcp__kone__scratchpad_read")).toBe("scratchpad_read");
    expect(canonicalToolName("kone__scratchpad_read")).toBe("scratchpad_read");
    expect(canonicalToolName("kone_scratchpad_read")).toBe("scratchpad_read");
    expect(canonicalToolName("kone_app_set_theme")).toBe("app_set_theme");
    expect(canonicalToolName("mcp__kone__app_set_theme")).toBe("app_set_theme");
  });

  // A provider that defers tools reaches the on-demand ones through a second
  // server; they are still kone's own tools.
  test("unwraps the on-demand server the same as the main one", () => {
    expect(canonicalToolName("mcp__kone_extra__code_lsp")).toBe("code_lsp");
    expect(canonicalToolName("kone_extra__code_lsp")).toBe("code_lsp");
    expect(canonicalToolName("mcp__kone_extras__code_lsp")).toBe("mcp__kone_extras__code_lsp");
  });

  // Stored threads keep the names their calls were made under.
  test("brings a name from before the rename up to date, however it was stamped", () => {
    expect(canonicalToolName("kone_spawn_worker")).toBe("agent_spawn");
    expect(canonicalToolName("mcp__kone__kone_wait_for_responses")).toBe("agent_wait");
    expect(canonicalToolName("kone_kone_scratchpad_write")).toBe("scratchpad_write");
    expect(canonicalToolName("mcp__kone_extra__kone_lsp")).toBe("code_lsp");
  });

  test("brings a worker or peer name up to its agent tool", () => {
    expect(canonicalToolName("mcp__kone__worker_continue")).toBe("agent_ask");
    expect(canonicalToolName("kone__peer_send")).toBe("agent_notify");
    expect(canonicalToolName("worker_spawn_batch")).toBe("agent_spawn_batch");
  });

  test("leaves a foreign tool that merely starts with kone alone", () => {
    expect(canonicalToolName("kone_something_else")).toBe("kone_something_else");
    expect(canonicalToolName("read_file")).toBe("read_file");
  });
});
