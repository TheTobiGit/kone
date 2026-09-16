import { describe, expect, test } from "bun:test";
import type { AssistantBlock } from "~/composables/useAgent";
import { describeTurnActivity } from "./turnActivity";
import { canonicalToolName } from "./toolName";

/** Names reach the pill already canonical — the reducer and the stored-block
 *  adopter both stamp them on the way in — so the fixtures do the same. */
function runningBlock(providerName: string, text: string): AssistantBlock {
  return {
    id: "block-1",
    role: "assistant",
    turnId: "turn-1",
    state: "running",
    at: 0,
    items: [
      {
        itemId: "item-1",
        kind: "tool_call",
        status: "in-progress",
        name: canonicalToolName(providerName),
        text,
      },
    ],
  };
}

describe("turnActivity", () => {
  describe("kone_spawn_batch", () => {
    test("labels the bare tool once", () => {
      expect(describeTurnActivity(runningBlock("kone_spawn_batch", ""))?.label).toBe(
        "Running kone spawn batch",
      );
      expect(describeTurnActivity(runningBlock("kone_spawn_batch", "kone_spawn_batch"))?.label).toBe(
        "Running kone spawn batch",
      );
    });

    test("labels server-qualified names once, never kone kone", () => {
      const cases: Array<[string, string]> = [
        ["kone__kone_spawn_batch", ""],
        ["kone__kone_spawn_batch", 'kone_spawn_batch: {"items": []}'],
        ["mcp__kone__kone_spawn_batch", ""],
        ["mcp__kone__kone_spawn_batch", 'kone_spawn_batch: {"items": []}'],
        ["kone_spawn_batch", "kone: dispatching 3 workers"],
        ["kone__kone_spawn_batch", "kone: dispatching 3 workers"],
      ];
      for (const [name, text] of cases) {
        const label = describeTurnActivity(runningBlock(name, text))?.label ?? "";
        expect(label).toBe("Running kone spawn batch");
        expect(label.toLowerCase().includes("kone kone")).toBe(false);
      }
    });

    test("keeps foreign MCP tools on the generic label", () => {
      expect(describeTurnActivity(runningBlock("mcp__github__fetch_pr", ""))?.label).toBe(
        "Running an MCP tool",
      );
    });
  });
});
