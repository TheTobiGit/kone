import { describe, expect, test } from "bun:test";
import { formatSpawnResult } from "@kone/protocol/spawn-record";
import type { AssistantBlock } from "~/composables/useAgent";
import type { RuntimeItem } from "~/types/desktop";
import { DEFAULT_DISPLAYS, RESPONSE_OPTIONS, type ResponseDisplay } from "./responseDisplay";
import type { RenderGroup } from "./conversationSegments";
import { planTurn } from "./turnPlan";

const STUDIO = DEFAULT_DISPLAYS.studio;

function display(choices: Partial<ResponseDisplay> = {}): ResponseDisplay {
  return { ...STUDIO, ...choices };
}

function block(items: RuntimeItem[], state: AssistantBlock["state"] = "running"): AssistantBlock {
  return { id: "b", role: "assistant", turnId: "t", state, at: 0, items };
}
const tool = (id: string): RuntimeItem => ({ itemId: id, kind: "tool_call", status: "completed", name: "read", text: "" });
const text = (id: string, status: RuntimeItem["status"] = "completed"): RuntimeItem => ({
  itemId: id,
  kind: "assistant_text",
  status,
  text: id,
});
const spawn = (id: string): RuntimeItem => ({
  itemId: id,
  kind: "tool_call",
  status: "completed",
  name: "kone_spawn_worker",
  text: "",
  detail: formatSpawnResult({
    spawns: [{ threadId: `child-${id}`, title: "t", provider: "codex", why: null }],
    summary: "s",
  }),
});

/** A group as a short tag: steps list their items, text its item, spawns their child. */
function tag(g: RenderGroup): string {
  if (g.kind === "steps") return `steps:${g.segments.flatMap((s) => s.items.map((i) => i.itemId)).join(",")}`;
  if (g.kind === "text") return `text:${g.seg.items.map((i) => i.itemId).join(",")}`;
  return `spawn:${g.record.threadId}`;
}
const tags = (groups: RenderGroup[] | null) => (groups ?? []).map(tag);
const liveIds = (plan: { live: { items: RuntimeItem[] }[] | null }) =>
  plan.live?.flatMap((s) => s.items.map((i) => i.itemId));

// update, work, update, work, reply
const TURN = [text("u1"), tool("r1"), text("u2"), tool("r2"), text("reply")];
const WORKING = TURN.slice(0, 4);

describe("planTurn while it works", () => {
  test("the studio's read shows every part, streaming text at the tail", () => {
    const plan = planTurn(block([...WORKING, text("reply", "in-progress")]), STUDIO);
    expect(tags(plan.inline)).toEqual(["text:u1", "steps:r1", "text:u2", "steps:r2", "text:reply"]);
    expect(plan.live).toBeNull();
    expect(plan.status).toBe(false);
    expect(plan.activity).toBe("auto");
  });

  test("the batch at the tail is the live one", () => {
    const plan = planTurn(block(WORKING), STUDIO);
    expect(tags(plan.inline)).toEqual(["text:u1", "steps:r1", "text:u2"]);
    expect(liveIds(plan)).toEqual(["r2"]);
  });

  test("a turn with nothing yet carries a bare orb", () => {
    expect(planTurn(block([]), STUDIO).live).toEqual([]);
  });

  test("hidden tool calls leave the updates and a status line", () => {
    const plan = planTurn(block(WORKING), display({ liveTools: "hidden" }));
    expect(tags(plan.inline)).toEqual(["text:u1", "text:u2"]);
    expect(plan.status).toBe(true);
  });

  test("hidden updates leave the work, read as one batch", () => {
    const plan = planTurn(block([...WORKING, text("reply", "in-progress")]), display({ liveUpdates: "hide" }));
    expect(tags(plan.inline)).toEqual([]);
    expect(liveIds(plan)).toEqual(["r1", "r2"]);
  });

  test("the inbox's read is just the status line", () => {
    const plan = planTurn(block(TURN), DEFAULT_DISPLAYS.inbox);
    expect(tags(plan.inline)).toEqual([]);
    expect(plan.status).toBe(true);
  });

  test("read whole, a message still being written waits — and the orb stays up", () => {
    const plan = planTurn(block([tool("r1"), text("u1", "in-progress")]), display({ liveText: "whole" }));
    expect(tags(plan.inline)).toEqual([]);
    expect(liveIds(plan)).toEqual(["r1"]);
  });

  test("the live choice sets how batches hold", () => {
    expect(planTurn(block(WORKING), display({ liveTools: "expanded" })).activity).toBe("open");
    expect(planTurn(block(WORKING), display({ liveTools: "folded" })).activity).toBe("closed");
  });

  test("thinking and the tool calls after it read as one batch", () => {
    const think: RuntimeItem = { itemId: "k1", kind: "reasoning_text", status: "completed", text: "hm" };
    const plan = planTurn(block([think, tool("r1")]), STUDIO);
    expect(liveIds(plan)).toEqual(["k1", "r1"]);
  });

  test("spawn lines show whatever else is hidden", () => {
    const plan = planTurn(block([spawn("s1"), tool("r1")]), DEFAULT_DISPLAYS.inbox);
    expect(tags(plan.inline)).toEqual(["spawn:child-s1"]);
  });
});

describe("planTurn when it's done", () => {
  test("work and updates hidden, the turn folds to its reply", () => {
    const plan = planTurn(block([...TURN.slice(0, 2), spawn("s1"), ...TURN.slice(2)], "completed"), STUDIO);
    expect(tags(plan.fold)).toEqual(["text:u1", "steps:r1", "text:u2", "steps:r2"]);
    expect(tags(plan.inline)).toEqual(["spawn:child-s1", "text:reply"]);
    expect(plan.foldOpen).toBe(false);
  });

  test("a turn that only spoke and spawned has no work to fold", () => {
    const plan = planTurn(block([text("u1"), spawn("s1")], "completed"), STUDIO);
    expect(tags(plan.inline)).toEqual(["text:u1", "spawn:child-s1"]);
    expect(plan.toggle).toBeNull();
  });

  test("a spawn said after the reply stays in the open, after it", () => {
    const plan = planTurn(block([...TURN, spawn("s1")], "completed"), STUDIO);
    expect(tags(plan.inline)).toEqual(["text:reply", "spawn:child-s1"]);
    expect(plan.toggle).toEqual({ open: false });
  });

  test("a turn that ended on a tool call folds open, having no reply", () => {
    expect(planTurn(block(WORKING, "completed"), STUDIO).foldOpen).toBe(true);
  });

  test("shown, the turn reads as it ran — the done choice setting how batches hold", () => {
    const plan = planTurn(block(TURN, "completed"), display({ doneTools: "folded", doneUpdates: "show" }));
    expect(plan.fold).toBeNull();
    expect(tags(plan.inline)).toEqual(["text:u1", "steps:r1", "text:u2", "steps:r2", "text:reply"]);
    expect(plan.activity).toBe("closed");
  });

  test("work shown, updates hidden: the work and the reply", () => {
    const plan = planTurn(block(TURN, "completed"), display({ doneTools: "expanded", doneUpdates: "hide" }));
    expect(tags(plan.inline)).toEqual(["steps:r1,r2", "text:reply"]);
  });

  test("work hidden, updates shown: what it said, and the reply", () => {
    const plan = planTurn(block(TURN, "completed"), display({ doneTools: "hidden", doneUpdates: "show" }));
    expect(tags(plan.inline)).toEqual(["text:u1", "text:u2", "text:reply"]);
  });

  // The one constant: however the reader has it, a finished turn shows its reply.
  test("every combination ends on the final reply", () => {
    for (const lt of RESPONSE_OPTIONS.liveTools)
      for (const lu of RESPONSE_OPTIONS.liveUpdates)
        for (const tx of RESPONSE_OPTIONS.liveText)
          for (const dt of RESPONSE_OPTIONS.doneTools)
            for (const du of RESPONSE_OPTIONS.doneUpdates) {
              const d = display({ liveTools: lt.id, liveUpdates: lu.id, liveText: tx.id, doneTools: dt.id, doneUpdates: du.id });
              const plan = planTurn(block(TURN, "completed"), d);
              expect({ d, last: tags(plan.inline).at(-1) }).toEqual({ d, last: "text:reply" });
            }
  });
});

describe("planTurn by hand", () => {
  test("a turn showing everything folds to its reply by hand", () => {
    const all = display({ doneTools: "expanded", doneUpdates: "show" });
    expect(planTurn(block(TURN, "completed"), all).toggle).toEqual({ open: true });
    const closed = planTurn(block(TURN, "completed"), all, false);
    expect(closed.toggle).toEqual({ open: false });
    expect(tags(closed.inline)).toEqual(["text:reply"]);
  });

  test("a folded turn opens by hand onto everything", () => {
    expect(planTurn(block(TURN, "completed"), STUDIO).toggle).toEqual({ open: false });
    const open = planTurn(block(TURN, "completed"), STUDIO, true);
    expect(open.foldOpen).toBe(true);
    expect(tags(open.fold)).toEqual(["text:u1", "steps:r1", "text:u2", "steps:r2"]);
  });

  test("a turn holding something back reads closed, and opens onto the whole turn", () => {
    const some = display({ doneTools: "hidden", doneUpdates: "show" });
    expect(planTurn(block(TURN, "completed"), some).toggle).toEqual({ open: false });
    expect(planTurn(block(TURN, "completed"), some, true).foldOpen).toBe(true);
  });

  test("while it works, the toggle shows only when something is held back", () => {
    expect(planTurn(block(WORKING), STUDIO).toggle).toBeNull();
    expect(planTurn(block(WORKING), DEFAULT_DISPLAYS.inbox).toggle).toEqual({ open: false });
  });

  test("opened while it works, hidden steps and updates show live", () => {
    const plan = planTurn(block(WORKING), DEFAULT_DISPLAYS.inbox, true);
    expect(plan.status).toBe(false);
    expect(tags(plan.inline)).toEqual(["text:u1", "steps:r1", "text:u2"]);
    expect(liveIds(plan)).toEqual(["r2"]);
  });

  test("a turn with no work has nothing to toggle", () => {
    expect(planTurn(block([text("reply")], "completed"), STUDIO).toggle).toBeNull();
    expect(planTurn(block([text("reply")], "completed"), display({ doneTools: "expanded", doneUpdates: "show" })).toggle).toBeNull();
  });
});
