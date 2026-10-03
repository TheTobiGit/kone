import { describe, expect, test } from "bun:test";

import { actionsLine, finalReplyOf, latestTurn, renderFinal, renderResponse } from "./agentRead.js";
import type { RuntimeItem, StoredBlock } from "./types.js";

const MAIN = { kind: "agent", threadId: "t-main", name: "Main agent", relationship: "delegator" } as const;

function user(id: string, text: string, extra: Partial<Extract<StoredBlock, { role: "user" }>> = {}): StoredBlock {
  return { id, role: "user", text, at: 0, ...extra };
}

function reply(
  id: string,
  turnId: string,
  items: RuntimeItem[],
  extra: Partial<Extract<StoredBlock, { role: "assistant" }>> = {},
): StoredBlock {
  return { id, role: "assistant", turnId, items, state: "completed", at: 0, ...extra };
}

function said(itemId: string, text: string): RuntimeItem {
  return { itemId, kind: "assistant_text", status: "completed", text };
}

function ran(itemId: string, name: string, text: string, status: RuntimeItem["status"] = "completed"): RuntimeItem {
  return { itemId, kind: "tool_call", status, text, name };
}

describe("latestTurn", () => {
  test("is the newest request and every piece of the turn answering it", () => {
    const blocks = [
      user("u1", "first ask"),
      reply("a1", "t1", [said("i1", "old answer")]),
      user("u2", "build the login", { sender: MAIN }),
      reply("a2", "t2", [said("i2", "Looking")]),
      user("s1", "in a table", { steered: true }),
      reply("a2~s1", "t2", [said("i3", "| path |")], { continues: "a2" }),
    ];
    const turn = latestTurn(blocks)!;
    expect(turn.turnId).toBe("t2");
    expect(turn.request?.id).toBe("u2");
    expect(turn.blocks.map((b) => b.id)).toEqual(["a2", "s1", "a2~s1"]);
  });

  test("keeps a message steered in before the reply said anything with the turn, not as its request", () => {
    const blocks = [
      user("u1", "what is this project?"),
      user("s1", "in a table", { steered: true }),
      reply("a1", "t1", [said("i1", "| path |")]),
    ];
    const turn = latestTurn(blocks)!;
    expect(turn.request?.id).toBe("u1");
    expect(turn.blocks.map((b) => b.id)).toEqual(["s1", "a1"]);
  });

  test("is null before any turn started", () => {
    expect(latestTurn([user("u1", "hello")])).toBeNull();
    expect(latestTurn([])).toBeNull();
  });
});

describe("finalReplyOf", () => {
  test("is the text after the turn's last step, across its pieces", () => {
    const turn = latestTurn([
      user("u1", "build it"),
      reply("a1", "t1", [said("i1", "Looking"), ran("i2", "Read", "auth.ts")]),
      user("s1", "hurry", { steered: true }),
      reply("a1~s1", "t1", [said("i3", "Done: "), said("i4", "it is in.")], { continues: "a1" }),
    ])!;
    expect(finalReplyOf(turn)).toBe("Done: it is in.");
  });

  test("passes over the tool calls a turn ended on", () => {
    const turn = latestTurn([
      user("u1", "build it"),
      reply("a1", "t1", [ran("i1", "Read", "a.ts"), said("i2", "Report."), ran("i3", "Bash", "git status")]),
    ])!;
    expect(finalReplyOf(turn)).toBe("Report.");
  });

  test("is null when the turn said nothing", () => {
    const turn = latestTurn([user("u1", "go"), reply("a1", "t1", [ran("i1", "Bash", "ls")])])!;
    expect(finalReplyOf(turn)).toBeNull();
  });
});

describe("actionsLine", () => {
  test("names each tool with its target, marks failures, and counts past the cap", () => {
    const items = Array.from({ length: 14 }, (_, i) => ran(`i${i}`, "Read", `f${i}.ts`));
    items[1] = ran("i1", "Bash", "bun test", "failed");
    const turn = latestTurn([user("u1", "go"), reply("a1", "t1", items)])!;
    const line = actionsLine(turn)!;
    expect(line.startsWith("Read(f0.ts), Bash(bun test) failed, Read(f2.ts)")).toBe(true);
    expect(line.endsWith("(+2 more)")).toBe(true);
  });

  test("is null for a turn that ran nothing", () => {
    const turn = latestTurn([user("u1", "go"), reply("a1", "t1", [said("i1", "hi")])])!;
    expect(actionsLine(turn)).toBeNull();
  });
});

describe("rendering", () => {
  test("a running turn says the reply is not finished", () => {
    const turn = latestTurn([user("u1", "go"), reply("a1", "t1", [said("i1", "So far")], { state: "running" })]);
    expect(renderFinal(turn, '"Login"')).toContain("still working — this is what it has written so far");
  });

  test("a failed turn says why", () => {
    const turn = latestTurn([user("u1", "go"), reply("a1", "t1", [], { state: "failed", error: "quota" })]);
    expect(renderResponse(turn, '"Login"')).toContain("(turn t1, failed: quota)");
  });

  test("a turn that said nothing after its work points at the whole response", () => {
    const turn = latestTurn([user("u1", "go"), reply("a1", "t1", [ran("i1", "Bash", "ls")])]);
    expect(renderFinal(turn, '"Login"')).toContain('Read scope "response" for the whole turn.');
  });

  test("the response names who asked and where a message arrived mid-turn", () => {
    const turn = latestTurn([
      user("u1", "build the login", { sender: MAIN }),
      reply("a1", "t1", [said("i1", "Looking")]),
      user("s1", "skip OAuth", { steered: true, sender: MAIN }),
      reply("a1~s1", "t1", [said("i2", "Done.")], { continues: "a1" }),
    ]);
    const text = renderResponse(turn, '"Login"');
    expect(text).toContain("Latest request, from Main agent:\nbuild the login");
    expect(text).toContain("Looking\n\n[message from Main agent arrived here] skip OAuth\n\nDone.");
  });

  test("a reply over the cap is cut with a marker", () => {
    const turn = latestTurn([user("u1", "go"), reply("a1", "t1", [said("i1", "x".repeat(500))])]);
    const text = renderFinal(turn, '"Login"', 300);
    expect(text).toContain("cut at 300 characters");
    expect(text.length).toBeLessThan(500);
  });

  test("a thread with no turn says so", () => {
    expect(renderFinal(null, '"Login"')).toBe('"Login" has no reply yet.');
    expect(renderResponse(null, '"Login"')).toBe('"Login" has no reply yet.');
  });
});
