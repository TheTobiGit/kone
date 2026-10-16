import { describe, expect, test } from "bun:test";
import { formatSpawnResult } from "@kone/protocol/spawn-record";
import { formatVisualShown, visualEmbed } from "@kone/protocol/visual-render";
import type { AssistantBlock } from "~/composables/useAgent";
import type { RuntimeItem } from "~/types/desktop";
import { renderGroups, segText } from "./conversationSegments";

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
    name: "agent_spawn",
    text: "",
    detail: formatSpawnResult({
      spawns: [{ threadId, title: "Fix tests", provider: "codex", why: "the suite is slow" }],
      summary: `Spawned "Fix tests" on codex as ${threadId}.`,
    }),
  };
}

const groupTags = (items: RuntimeItem[]) =>
  renderGroups(block(items)).map((g) =>
    g.kind === "steps"
      ? `steps:${g.segments.flatMap((s) => s.items.map((i) => i.itemId)).join(",")}`
      : g.kind === "text"
        ? `text:${g.seg.items.map((i) => i.itemId).join(",")}`
        : g.kind === "decision"
          ? `decision:${g.item.itemId}`
          : g.kind === "visual"
            ? `visual:${g.visual.attachmentId}`
            : `spawn:${g.record.threadId}`,
  );

describe("renderGroups", () => {
  test("a spawn stands where it landed, splitting the tool run around it", () => {
    expect(groupTags([text("a", "On it."), tool("r1"), spawn("s1", "child-1"), tool("r2"), text("z", "Done.")])).toEqual([
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
    const refused: RuntimeItem = { ...tool("s2", "agent_spawn"), detail: "Spawn depth limit reached." };
    expect(groupTags([spawn("s1", "child-1", "in-progress"), refused])).toEqual(["steps:s1,s2"]);
  });

  test("a preset spawn stands the same way", () => {
    const preset: RuntimeItem = { ...spawn("s1", "child-1"), name: "agent_spawn_preset" };
    expect(groupTags([tool("r1"), preset, text("z", "Done.")])).toEqual(["steps:r1", "spawn:child-1", "text:z"]);
  });

  test("a delegation stands the same way, naming the teammate", () => {
    const delegated: RuntimeItem = { ...spawn("s1", "child-1"), name: "agent_delegate" };
    const groups = renderGroups(block([delegated]));
    expect(groups.map((g) => g.kind)).toEqual(["spawn"]);
  });

  test("a batch stands as one line per thread it opened, in item order", () => {
    const record = (threadId: string) => ({
      threadId,
      title: threadId,
      provider: "codex",
      why: null,
    });
    const batch: RuntimeItem = {
      ...tool("b1", "agent_spawn_batch"),
      detail: formatSpawnResult({
        spawns: [record("child-a"), { ...record("child-b"), agent: "Ada" }],
        summary: "Spawned 2 threads.",
      }),
    };
    expect(groupTags([text("a", "Splitting it up."), batch, tool("r1")])).toEqual([
      "text:a",
      "spawn:child-a",
      "spawn:child-b",
      "steps:r1",
    ]);
  });

  test("a batch where nothing opened stays a step", () => {
    const refused: RuntimeItem = { ...tool("b1", "agent_spawn_batch"), detail: "1 spawn failed: item 0: nope." };
    expect(groupTags([refused])).toEqual(["steps:b1"]);
  });

  test("a replayed spawn of the same worker is said once", () => {
    expect(groupTags([spawn("s1", "child-1"), spawn("s2", "child-1")])).toEqual(["spawn:child-1"]);
  });

  test("a shown visual stands in the reply where it landed, splitting the tool run", () => {
    const shown: RuntimeItem = {
      ...tool("p1", "visual_show"),
      detail: formatVisualShown({ attachmentId: "att_1234", title: "Latency", height: 320 }),
    };
    expect(groupTags([tool("r1"), shown, tool("r2"), text("z", "Done.")])).toEqual([
      "steps:r1",
      "visual:att_1234",
      "steps:r2",
      "text:z",
    ]);
  });

  test("a visual kone put in the turn and the provider's own report of the call stand once", () => {
    const detail = formatVisualShown({ attachmentId: "att_1234", title: "Latency", height: 320 });
    const reported: RuntimeItem = { ...tool("p1", "visual_show"), detail };
    const put: RuntimeItem = { ...tool("visual:att_1234", "visual_show"), detail };
    expect(groupTags([reported, tool("r1"), put])).toEqual(["visual:att_1234", "steps:r1"]);
  });

  test("a visual call still running, or refused, stays a step", () => {
    const running: RuntimeItem = {
      ...tool("p1", "visual_show"),
      status: "in-progress",
      detail: formatVisualShown({ attachmentId: "att_1234", title: "Latency", height: 320 }),
    };
    const refused: RuntimeItem = { ...tool("p2", "visual_show"), detail: "invalid_input: No file at: /tmp/a.png." };
    expect(groupTags([running, refused])).toEqual(["steps:p1,p2"]);
  });

  test("a visual shown under its old tool name, with its old record, still stands in the reply", () => {
    const legacy: RuntimeItem = {
      ...tool("p1", "page_show"),
      detail: JSON.stringify({ page: { attachmentId: "att_1234", title: "Latency", height: 320 }, note: "Shown." }),
    };
    expect(groupTags([legacy])).toEqual(["visual:att_1234"]);
  });
});

describe("renderGroups with visuals the agent placed", () => {
  const shown = (attachmentId: string): RuntimeItem => ({
    ...tool(`visual:${attachmentId}`, "visual_show"),
    detail: formatVisualShown({ attachmentId, title: "Latency", height: 320 }),
  });
  const texts = (items: RuntimeItem[]) =>
    renderGroups(block(items)).flatMap((g) => (g.kind === "text" ? [segText(g.seg)] : g.kind === "visual" ? [`[${g.visual.attachmentId}]`] : []));

  test("a placed visual stands where the text puts it, not at its call", () => {
    const reply = text("a", `Latency rose last week.\n\n${visualEmbed("att_1234")}\n\nMost of it is one region.`);
    expect(groupTags([shown("att_1234"), reply])).toEqual(["text:a", "visual:att_1234", "text:a:2"]);
    expect(texts([shown("att_1234"), reply])).toEqual(["Latency rose last week.", "[att_1234]", "Most of it is one region."]);
  });

  test("a visual the text never places stands at its call", () => {
    const reply = text("a", `Here.\n\n${visualEmbed("att_1234")}`);
    expect(texts([shown("att_1234"), shown("att_5678"), reply])).toEqual(["[att_5678]", "Here.", "[att_1234]"]);
  });

  test("a placement naming no visual of the turn is dropped, and a repeat stands once", () => {
    const reply = text("a", `${visualEmbed("att_9999")}\nOne.\n${visualEmbed("att_1234")}\nTwo.\n${visualEmbed("att_1234")}`);
    expect(texts([shown("att_1234"), reply])).toEqual(["One.", "[att_1234]", "Two."]);
  });

  test("a reply still arriving keeps an unfinished placement out of the text", () => {
    const live: RuntimeItem = { ...text("a", "Look:\n```kone-vis"), status: "in-progress" };
    const groups = renderGroups(block([shown("att_1234"), live]));
    expect(groups.map((g) => (g.kind === "text" ? segText(g.seg) : g.kind))).toEqual(["visual", "Look:"]);
    const tail = groups[groups.length - 1]!;
    expect(tail.kind === "text" && tail.seg.items[0]!.status).toBe("in-progress");
  });

  test("text in a turn that showed no visual is left as it was", () => {
    const reply = text("a", "```kone-visual\natt_1234\n```");
    const [group] = renderGroups(block([reply]));
    expect(group?.kind === "text" && group.seg.items[0]).toBe(reply);
  });
});
