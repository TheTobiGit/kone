import { describe, expect, test } from "bun:test";
import type { AssistantBlock } from "~/composables/agentTypes";
import type { RuntimeItem } from "~/types/desktop";
import type { ToolOrbFamily } from "~/utils/toolOrb/types";
import { formatDuration, summarizeResponse } from "./responseTrace";

const FAMILY: Record<string, ToolOrbFamily> = { read: "read", edit: "write", bash: "run", agent: "agent" };
const familyOf = (name: string | undefined): ToolOrbFamily => FAMILY[name ?? ""] ?? "neutral";

let n = 0;
function call(name: string, extra: Partial<RuntimeItem> = {}): RuntimeItem {
  n += 1;
  return { itemId: `i${n}`, kind: "tool_call", status: "completed", text: "", name, ...extra };
}
function text(body: string): RuntimeItem {
  n += 1;
  return { itemId: `i${n}`, kind: "assistant_text", status: "completed", text: body };
}
function piece(items: RuntimeItem[], over: Partial<AssistantBlock> = {}): AssistantBlock {
  return { id: `b${n}`, role: "assistant", turnId: "t1", items, state: "completed", at: 1_000, endedAt: 61_000, ...over };
}

describe("summarizeResponse", () => {
  test("nothing to read gives nothing", () => {
    expect(summarizeResponse([], familyOf)).toBeNull();
  });

  test("tallies the turn's tools by kind, most-used first", () => {
    const s = summarizeResponse([piece([call("read"), call("edit"), call("read"), call("bash", { status: "failed" })])], familyOf)!;
    expect(s.toolCalls).toBe(4);
    expect(s.failedCalls).toBe(1);
    expect(s.tools).toEqual([
      { family: "read", label: "Read", count: 2 },
      { family: "write", label: "Edit", count: 1 },
      { family: "run", label: "Run", count: 1 },
    ]);
  });

  test("reads every piece of a steered turn as one response", () => {
    const s = summarizeResponse(
      [
        piece([call("read"), text("First part.")], { at: 1_000, endedAt: undefined }),
        piece([call("edit"), text("Done.")], { at: 20_000, endedAt: 90_000, continues: "b0" }),
      ],
      familyOf,
    )!;
    expect(s.toolCalls).toBe(2);
    expect(s.startedAt).toBe(1_000);
    expect(s.endedAt).toBe(90_000);
    expect(s.reply).toBe("Done.");
  });

  test("counts subagents and the calls they made, nested runs included", () => {
    const inner = call("agent", {
      subagent: { toolUseId: "s2", status: "completed", startedAt: 0, items: [call("read")] },
    });
    const outer = call("agent", {
      subagent: { toolUseId: "s1", status: "completed", startedAt: 0, items: [call("read"), inner] },
    });
    const s = summarizeResponse([piece([outer])], familyOf)!;
    expect(s.toolCalls).toBe(1);
    expect(s.subagents).toBe(1);
    expect(s.subagentCalls).toBe(3);
  });

  test("a running turn has no end yet", () => {
    const s = summarizeResponse([piece([call("read")], { state: "running", endedAt: undefined })], familyOf)!;
    expect(s.state).toBe("running");
    expect(s.endedAt).toBeUndefined();
  });
});

describe("formatDuration", () => {
  test("reads seconds, minutes and hours", () => {
    expect(formatDuration(48_400)).toBe("48s");
    expect(formatDuration(134_000)).toBe("2m 14s");
    expect(formatDuration(3_780_000)).toBe("1h 3m");
  });
});
