import { describe, expect, test } from "bun:test";
import { formatSpawnBatchRecord, formatSpawnRecord } from "@kone/protocol/spawn-record";
import type { AssistantBlock } from "~/composables/useAgent";
import type { RuntimeItem } from "~/types/desktop";
import { renderGroups } from "./conversationSegments";

function block(items: RuntimeItem[]): AssistantBlock {
  return { id: "b", role: "assistant", turnId: "t", state: "completed", at: 0, items };
}

function tool(itemId: string, name = "read"): RuntimeItem {
  return { itemId, kind: "tool_call", status: "completed", name, text: "" };
}

function text(itemId: string, body: string): RuntimeItem {
  return { itemId, kind: "assistant_text", status: "completed", text: body };
}

function spawn(itemId: string, threadId: string, status: RuntimeItem["status"] = "completed"): RuntimeItem {
  return {
    itemId,
    kind: "tool_call",
    status,
    name: "kone_spawn_worker",
    text: "",
    detail: formatSpawnRecord({
      threadId,
      title: "Fix tests",
      provider: "codex",
      why: "the suite is slow",
      summary: `Spawned "Fix tests" on codex as ${threadId}.`,
    }),
  };
}

const shape = (items: RuntimeItem[]) =>
  renderGroups(block(items)).map((g) =>
    g.kind === "steps"
      ? `steps:${g.segments.flatMap((s) => s.items.map((i) => i.itemId)).join(",")}`
      : g.kind === "text"
        ? `text:${g.seg.items.map((i) => i.itemId).join(",")}`
        : `spawn:${g.record.threadId}`,
  );

describe("renderGroups", () => {
  test("a spawn stands where it landed, splitting the tool run around it", () => {
    expect(shape([text("a", "On it."), tool("r1"), spawn("s1", "child-1"), tool("r2"), text("z", "Done.")])).toEqual([
      "text:a",
      "steps:r1",
      "spawn:child-1",
      "steps:r2",
      "text:z",
    ]);
  });

  test("an unsplit run keeps the key it always had", () => {
    const groups = renderGroups(block([tool("r1"), tool("r2")]));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind === "steps" && groups[0]!.key).toBe("b:r1");
  });

  test("a spawn still running, or refused, stays a step", () => {
    const refused: RuntimeItem = { ...tool("s2", "kone_spawn_worker"), detail: "Spawn depth limit reached." };
    expect(shape([spawn("s1", "child-1", "in-progress"), refused])).toEqual(["steps:s1,s2"]);
  });

  test("a preset spawn stands the same way", () => {
    const preset: RuntimeItem = { ...spawn("s1", "child-1"), name: "kone_spawn_worker_preset" };
    expect(shape([tool("r1"), preset, text("z", "Done.")])).toEqual(["steps:r1", "spawn:child-1", "text:z"]);
  });

  test("a delegation stands the same way, naming the teammate", () => {
    const delegated: RuntimeItem = { ...spawn("s1", "child-1"), name: "kone_delegate_to_teammate" };
    const groups = renderGroups(block([delegated]));
    expect(groups.map((g) => g.kind)).toEqual(["spawn"]);
  });

  test("a batch stands as one line per thread it opened, in item order", () => {
    const record = (threadId: string) => ({
      threadId,
      title: threadId,
      provider: "codex",
      why: null,
      summary: `Spawned ${threadId}.`,
    });
    const batch: RuntimeItem = {
      ...tool("b1", "kone_spawn_batch"),
      detail: formatSpawnBatchRecord({
        spawns: [record("child-a"), { ...record("child-b"), agent: "Ada" }],
        summary: "Spawned 2 threads.",
      }),
    };
    expect(shape([text("a", "Splitting it up."), batch, tool("r1")])).toEqual([
      "text:a",
      "spawn:child-a",
      "spawn:child-b",
      "steps:r1",
    ]);
  });

  test("a batch where nothing opened stays a step", () => {
    const refused: RuntimeItem = { ...tool("b1", "kone_spawn_batch"), detail: "1 spawn failed: item 0: nope." };
    expect(shape([refused])).toEqual(["steps:b1"]);
  });

  test("a replayed spawn of the same worker is said once", () => {
    expect(shape([spawn("s1", "child-1"), spawn("s2", "child-1")])).toEqual(["spawn:child-1"]);
  });
});
