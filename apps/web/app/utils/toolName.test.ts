import { describe, expect, test } from "bun:test";
import type { RuntimeItem } from "../types/desktop";
import { canonicalizeItem, canonicalToolName } from "./toolName";

function toolCall(name: string, extra: Partial<RuntimeItem> = {}): RuntimeItem {
  return { itemId: "item-1", kind: "tool_call", status: "in-progress", text: "", name, ...extra };
}

describe("canonicalizeItem", () => {
  test("restamps a qualified tool_call with its canonical name", () => {
    expect(canonicalizeItem(toolCall("mcp__kone__kone_spawn_batch")).name).toBe("kone_spawn_batch");
    expect(canonicalizeItem(toolCall("kone__kone_spawn_batch")).name).toBe("kone_spawn_batch");
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
      text: "kone__kone_spawn_batch",
    };
    expect(canonicalizeItem(text)).toBe(text);
  });

  test("reaches into a nested subagent run", () => {
    const parent = toolCall("task", {
      subagent: {
        toolUseId: "use-1",
        startedAt: 0,
        status: "running",
        items: [toolCall("kone__kone_spawn_batch", { itemId: "child-1" })],
      },
    });
    const out = canonicalizeItem(parent);
    expect(out.subagent?.items[0]?.name).toBe("kone_spawn_batch");
    // The parent's own name needed no change, but the rebuild must not lose it.
    expect(out.name).toBe("task");
  });
});

describe("canonicalToolName", () => {
  test("folds a doubly-stamped head", () => {
    expect(canonicalToolName("kone_kone_spawn_batch")).toBe("kone_spawn_batch");
  });
});
