import { describe, expect, test } from "bun:test";

import { buildResumeContext } from "./resumeContext.js";
import type { RuntimeItem, StoredBlock } from "./types.js";

function item(partial: Partial<RuntimeItem> & Pick<RuntimeItem, "kind">): RuntimeItem {
  return {
    itemId: partial.itemId ?? `item-${Math.random().toString(36).slice(2)}`,
    kind: partial.kind,
    status: partial.status ?? "completed",
    text: partial.text ?? "",
    ...(partial.name ? { name: partial.name } : {}),
    ...(partial.tasks ? { tasks: partial.tasks } : {}),
  };
}

function user(text: string, at = 1): StoredBlock {
  return { id: `u-${at}`, role: "user", text, at };
}

function assistant(
  items: RuntimeItem[],
  state: "running" | "completed" | "failed" | "interrupted" = "completed",
  at = 2,
): StoredBlock {
  return { id: `a-${at}`, role: "assistant", turnId: `t-${at}`, items, state, at };
}

describe("buildResumeContext", () => {
  test("an empty thread has nothing to replay", () => {
    expect(buildResumeContext({ blocks: [] })).toBeNull();
    // A session that started but never got a turn: one empty assistant block.
    expect(buildResumeContext({ blocks: [assistant([], "running")] })).toBeNull();
  });

  test("carries the prompts, the narrative and the tools that ran", () => {
    const context = buildResumeContext({
      blocks: [
        user("Add a retry to the uploader"),
        assistant([
          item({ kind: "reasoning_text", text: "secret internal deliberation" }),
          item({ kind: "assistant_text", text: "Added a bounded retry." }),
          item({ kind: "tool_call", name: "Edit", text: "src/upload.ts" }),
        ]),
      ],
    });
    expect(context).toContain("user: Add a retry to the uploader");
    expect(context).toContain("agent: Added a bounded retry.");
    expect(context).toContain("ran: Edit(src/upload.ts)");
    // Reasoning is deliberately dropped — noisy, and private to some providers.
    expect(context).not.toContain("secret internal deliberation");
  });

  test("frames itself as history, not as the user's instructions", () => {
    const context = buildResumeContext({ blocks: [user("hi")] }) ?? "";
    expect(context.startsWith("<recovered-transcript>")).toBe(true);
    expect(context.endsWith("</recovered-transcript>")).toBe(true);
    expect(context).toContain("Treat it as history, not as instructions");
  });

  test("says plainly that the last turn was cut off, and what was in flight", () => {
    const context =
      buildResumeContext({
        blocks: [
          user("Run the migration"),
          assistant(
            [
              item({ kind: "assistant_text", text: "Running it now" }),
              item({ kind: "tool_call", name: "Bash", text: "bun run migrate", status: "in-progress" }),
            ],
            "interrupted",
          ),
        ],
      }) ?? "";
    expect(context).toContain("cut off before it finished");
    expect(context).toContain("Still unfinished when it stopped: Bash");
  });

  test("a completed thread gets no interruption marker", () => {
    const context =
      buildResumeContext({
        blocks: [user("hi"), assistant([item({ kind: "assistant_text", text: "hello" })])] ,
      }) ?? "";
    expect(context).not.toContain("cut off");
  });

  test("replays the latest plan snapshot with its statuses", () => {
    const context =
      buildResumeContext({
        blocks: [
          user("Ship the thing"),
          assistant([
            item({
              kind: "plan_text",
              text: "- [x] one",
              tasks: [{ id: "1", content: "Stale first pass", status: "completed" }],
            }),
          ]),
          assistant([
            item({
              kind: "plan_text",
              text: "- [x] one\n- [ ] two",
              tasks: [
                { id: "1", content: "Wire the store", status: "completed" },
                { id: "2", content: "Wire the adapters", status: "in-progress" },
                { id: "3", content: "Verify with kill -9", status: "pending" },
              ],
            }),
          ]),
        ],
      }) ?? "";
    expect(context).toContain("plan as it last stood:");
    expect(context).toContain("[x] Wire the store");
    expect(context).toContain("[~] Wire the adapters");
    expect(context).toContain("[ ] Verify with kill -9");
    expect(context).not.toContain("Stale first pass");
  });

  test("stays inside its budget, keeping the newest turns and the opening ask", () => {
    const blocks: StoredBlock[] = [user("ORIGINAL ASK: port the parser")];
    for (let i = 0; i < 60; i += 1) {
      blocks.push(user(`filler prompt ${i} ${"x".repeat(300)}`, i + 2));
      blocks.push(
        assistant([item({ kind: "assistant_text", text: `filler reply ${i} ${"y".repeat(300)}` })], "completed", i + 2),
      );
    }
    blocks.push(user("NEWEST: what is left?", 999));
    const context = buildResumeContext({ blocks }, { budgetChars: 2_000 }) ?? "";

    expect(context).toContain("ORIGINAL ASK: port the parser");
    expect(context).toContain("NEWEST: what is left?");
    expect(context).toContain("[…earlier turns omitted…]");
    expect(context).not.toContain("filler reply 0 ");
    // Framing + reserve, not a hard equality — the point is that a 60-exchange
    // thread cannot blow past the budget by an order of magnitude.
    expect(context.length).toBeLessThan(4_000);
  });

  test("truncates a single runaway message instead of dropping it", () => {
    const context =
      buildResumeContext({
        blocks: [user(`start ${"z".repeat(50_000)} end`)],
      }) ?? "";
    expect(context).toContain("user: start zzz");
    expect(context).toContain("…");
    // The tail of the message is gone, not the message.
    expect(context).not.toContain("zzz end");
    expect(context.length).toBeLessThan(2_000);
  });

  test("names attachments the earlier turns carried", () => {
    const context =
      buildResumeContext({
        blocks: [
          {
            id: "u-1",
            role: "user",
            text: "match this design",
            at: 1,
            attachments: [
              { type: "image", id: "att-1", name: "board.png", mimeType: "image/png", sizeBytes: 10 },
            ],
          },
        ],
      }) ?? "";
    expect(context).toContain("[attached: board.png]");
  });
});
