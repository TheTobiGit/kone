import { describe, expect, test } from "bun:test";

import {
  ATTACHMENT_IMAGE_TOKENS,
  ATTACHMENT_OTHER_TOKENS,
  DEFAULT_HANDOFF_TOKEN_CAP,
  HANDOFF_HISTORY_NOTE,
  MAX_HANDOFF_TOKEN_CAP,
  MIN_HANDOFF_TOKEN_CAP,
  UNKNOWN_CONTEXT_WINDOW_TOKENS,
  attachmentTokenAllowance,
  clampHandoffTokenCap,
  commandOutcome,
  handoffBudget,
  handoffWindowTokens,
  historicalBlockText,
  renderHistorySelection,
  selectHistoricalBlocks,
} from "./contextBudget.js";
import type { ChatAttachment, RuntimeItem, StoredBlock } from "./types.js";

function user(text: string, id = `u-${text}`): StoredBlock {
  return { id, role: "user", text, at: 1 };
}

function assistant(
  items: RuntimeItem[],
  state: "running" | "completed" | "failed" | "interrupted" = "completed",
  id = "a-1",
): StoredBlock {
  return { id, role: "assistant", turnId: "t-1", items, state, at: 2 };
}

function textItem(text: string, itemId = `i-${text}`) {
  return { itemId, kind: "assistant_text" as const, status: "completed" as const, text };
}

function image(name = "shot.png"): ChatAttachment {
  return { type: "image", id: name, name, mimeType: "image/png", sizeBytes: 10 };
}

function file(name = "notes.txt"): ChatAttachment {
  return { type: "file", id: name, name, mimeType: "text/plain", sizeBytes: 10 };
}

describe("clampHandoffTokenCap", () => {
  test("clamps to the configured bounds and rounds", () => {
    expect(clampHandoffTokenCap(0)).toBe(MIN_HANDOFF_TOKEN_CAP);
    expect(clampHandoffTokenCap(1_000_000)).toBe(MAX_HANDOFF_TOKEN_CAP);
    expect(clampHandoffTokenCap(20_000.6)).toBe(20_001);
    expect(clampHandoffTokenCap(Number.NaN)).toBe(DEFAULT_HANDOFF_TOKEN_CAP);
  });
});

describe("attachmentTokenAllowance", () => {
  test("charges images and other attachments separately", () => {
    expect(attachmentTokenAllowance([])).toBe(0);
    expect(attachmentTokenAllowance([image()])).toBe(ATTACHMENT_IMAGE_TOKENS);
    expect(attachmentTokenAllowance([file(), file()])).toBe(2 * ATTACHMENT_OTHER_TOKENS);
    expect(attachmentTokenAllowance([image(), file()])).toBe(
      ATTACHMENT_IMAGE_TOKENS + ATTACHMENT_OTHER_TOKENS,
    );
  });
});

describe("handoffWindowTokens", () => {
  test("prefers the selected window, then the model, then the report", () => {
    expect(handoffWindowTokens({ selectedWindowTokens: 200_000, modelWindowTokens: 1_000_000 })).toBe(200_000);
    expect(handoffWindowTokens({ modelWindowTokens: 400_000, reportedWindowTokens: 100_000 })).toBe(400_000);
    expect(handoffWindowTokens({ reportedWindowTokens: 100_000 })).toBe(100_000);
    expect(handoffWindowTokens({})).toBe(UNKNOWN_CONTEXT_WINDOW_TOKENS);
    expect(handoffWindowTokens({ selectedWindowTokens: 0 })).toBe(UNKNOWN_CONTEXT_WINDOW_TOKENS);
  });
});

describe("handoffBudget", () => {
  test("charges prompt and framing once against cap, transport and window", () => {
    const window = 80_000;
    const headroom = Math.min(Math.max(16_000, Math.ceil(window / 4)), Math.floor(window / 2)); // 20k
    const { fit, historyTokens } = handoffBudget({
      tokenCap: MAX_HANDOFF_TOKEN_CAP,
      windowTokens: window,
      nativeTokens: 10_000,
      promptChars: 4_000, // 1k tokens
      framingChars: 2_000, // 500 tokens
      transportCharCap: 1_000_000,
    });
    expect(fit).toBe(true);
    expect(historyTokens).toBe(window - 10_000 - headroom - 1_000 - 500);
  });

  test("the cap binds with a nonzero prompt", () => {
    const { fit, historyTokens } = handoffBudget({
      tokenCap: 1_024,
      windowTokens: 200_000,
      promptChars: 100,
      framingChars: 100,
      transportCharCap: 1_000_000,
    });
    expect(fit).toBe(true);
    expect(historyTokens).toBe(1_024);
  });

  test("the transport ceiling binds with a nonzero prompt", () => {
    const { fit, historyTokens } = handoffBudget({
      tokenCap: MAX_HANDOFF_TOKEN_CAP,
      windowTokens: 1_000_000,
      promptChars: 100,
      framingChars: 100,
      transportCharCap: 40_000,
    });
    expect(fit).toBe(true);
    // T = 10k; minus the prompt (25) and framing (25).
    expect(historyTokens).toBe(10_000 - 25 - 25);
  });

  test("the window binds with a nonzero prompt", () => {
    const window = 12_000;
    const headroom = Math.min(Math.max(16_000, Math.ceil(window / 4)), Math.floor(window / 2)); // 6k
    const { fit, historyTokens } = handoffBudget({
      tokenCap: MAX_HANDOFF_TOKEN_CAP,
      windowTokens: window,
      promptChars: 100,
      framingChars: 100,
      transportCharCap: 1_000_000,
    });
    expect(fit).toBe(true);
    expect(historyTokens).toBe(window - headroom - 25 - 25);
  });

  test("a 65k-character prompt at cap 16k / window 200k is accepted", () => {
    // Rowan's regression: the old double transport subtraction refused this.
    const { fit, historyTokens } = handoffBudget({
      tokenCap: DEFAULT_HANDOFF_TOKEN_CAP,
      windowTokens: 200_000,
      promptChars: 65_000,
      framingChars: 500,
      transportCharCap: 120_000,
    });
    expect(fit).toBe(true);
    expect(historyTokens).toBeGreaterThan(0);
  });

  test("a 60k-character prompt at cap 64k is accepted", () => {
    const { fit, historyTokens } = handoffBudget({
      tokenCap: MAX_HANDOFF_TOKEN_CAP,
      windowTokens: 200_000,
      promptChars: 60_000,
      framingChars: 500,
      transportCharCap: 120_000,
    });
    expect(fit).toBe(true);
    expect(historyTokens).toBeGreaterThan(0);
  });

  test("go on an 8k model is accepted with whatever history fits", () => {
    // The old headroom (16k) exceeded an 8k window and refused everything.
    const window = 8_000;
    const headroom = Math.min(Math.max(16_000, Math.ceil(window / 4)), Math.floor(window / 2)); // 4k
    const { fit, historyTokens } = handoffBudget({
      tokenCap: DEFAULT_HANDOFF_TOKEN_CAP,
      windowTokens: window,
      promptChars: 2,
      framingChars: 200,
      transportCharCap: 120_000,
    });
    expect(fit).toBe(true);
    expect(historyTokens).toBe(window - headroom - 1 - 50);
  });

  test("refuses only when the mandatory content cannot fit", () => {
    // F + P exceeds the window after headroom.
    const refused = handoffBudget({
      tokenCap: MAX_HANDOFF_TOKEN_CAP,
      windowTokens: 8_000,
      promptChars: 40_000, // 10k tokens
      framingChars: 200,
      transportCharCap: 120_000,
    });
    expect(refused.fit).toBe(false);
    // F + P exceeds the transport ceiling.
    const refusedTransport = handoffBudget({
      tokenCap: MAX_HANDOFF_TOKEN_CAP,
      windowTokens: 1_000_000,
      promptChars: 130_000,
      framingChars: 200,
      transportCharCap: 120_000,
    });
    expect(refusedTransport.fit).toBe(false);
  });

  test("a just-above-zero history budget still fits (coverage is in framing)", () => {
    // T = 151 tokens; prompt 500 chars (125) + framing 100 chars (25) = 150,
    // so history is 1 token — accepted, never a refusal.
    const { fit, historyTokens } = handoffBudget({
      tokenCap: MAX_HANDOFF_TOKEN_CAP,
      windowTokens: 1_000_000,
      promptChars: 500,
      framingChars: 100,
      transportCharCap: 604,
    });
    expect(fit).toBe(true);
    expect(historyTokens).toBe(1);
  });

  test("attachments are charged against the window only", () => {
    const window = 20_000;
    const { fit, historyTokens } = handoffBudget({
      tokenCap: MAX_HANDOFF_TOKEN_CAP,
      windowTokens: window,
      promptChars: 100,
      framingChars: 100,
      attachments: [image()],
      transportCharCap: 1_000_000,
    });
    const headroom = Math.min(Math.max(16_000, Math.ceil(window / 4)), Math.floor(window / 2)); // 10k
    expect(fit).toBe(true);
    expect(historyTokens).toBe(window - headroom - 25 - 25 - ATTACHMENT_IMAGE_TOKENS);
  });
});

describe("commandOutcome", () => {
  test("reads a JSON exit code, an exit-code line, or nothing", () => {
    expect(commandOutcome('{"exitCode":1}')).toBe("exit code 1");
    expect(commandOutcome('{"exit_code":0}')).toBe("exit code 0");
    expect(commandOutcome("done\nexit code: 2")).toBe("exit code 2");
    expect(commandOutcome("Exit 130")).toBe("exit code 130");
    expect(commandOutcome("no outcome here")).toBeNull();
    expect(commandOutcome(undefined)).toBeNull();
    expect(commandOutcome("   ")).toBeNull();
  });
});

describe("historicalBlockText", () => {
  test("renders a user message with its attachments, whole", () => {
    const text = historicalBlockText({ id: "u", role: "user", text: "  hello  ", at: 1, attachments: [image("a.png"), file("b.txt")] });
    expect(text).toBe("hello\n[Attachments: a.png, b.txt]");
  });

  test("carries prose, plans and commands with exit codes", () => {
    const text = historicalBlockText(
      assistant([
        textItem("I migrated the schema."),
        { itemId: "p1", kind: "plan_text", status: "completed", text: "", tasks: [{ id: "1", content: "Migrate", status: "completed" }] },
        { itemId: "c1", kind: "tool_call", status: "completed", name: "bash", text: "npx prisma migrate dev", detail: '{"exitCode":0}' },
        { itemId: "c2", kind: "tool_call", status: "failed", name: "bash", text: "bun test", detail: "boom\nexit code: 1" },
      ]),
    );
    expect(text).toContain("I migrated the schema.");
    expect(text).toContain("[Plan]\n- [completed] Migrate");
    expect(text).toContain("[Tool] bash: npx prisma migrate dev — exit code 0");
    expect(text).toContain("[Tool] bash: bun test — exit code 1 (failed)");
  });

  test("carries a failed tool's own diagnostic", () => {
    const text = historicalBlockText(
      assistant([
        {
          itemId: "c1",
          kind: "tool_call",
          status: "failed",
          name: "bash",
          text: "bun test",
          detail: "TypeError: broken\nexit code: 1",
        },
      ]),
    );
    expect(text).toContain("TypeError: broken");
    expect(text).toContain("exit code 1");
    expect(text).toContain("(failed)");
  });

  test("marks a failed turn and carries its error", () => {
    const text = historicalBlockText(assistant([textItem("half done")], "failed", "a-f"));
    expect(text).toContain("half done");
    expect(text).toContain("[Turn failed]");
  });

  test("replays only the latest plan revision", () => {
    const text = historicalBlockText(
      assistant([
        { itemId: "p1", kind: "plan_text", status: "completed", text: "old plan" },
        textItem("working"),
        { itemId: "p2", kind: "plan_text", status: "completed", text: "new plan" },
      ]),
    );
    expect(text).toContain("new plan");
    expect(text).not.toContain("old plan");
  });

  test("marks an interrupted or running turn as partial", () => {
    expect(historicalBlockText(assistant([textItem("x")], "interrupted"))).toContain("partial");
    expect(historicalBlockText(assistant([textItem("x")], "running"))).toContain("partial");
  });

  test("ignores reasoning and returns null for a genuinely empty block", () => {
    expect(
      historicalBlockText(assistant([{ itemId: "r", kind: "reasoning_text", status: "completed", text: "thinking" }])),
    ).toBeNull();
    expect(historicalBlockText(assistant([]))).toBeNull();
  });
});

describe("selectHistoricalBlocks", () => {
  test("keeps the priority messages and drops the rest whole", () => {
    const pad = "x".repeat(180);
    const blocks = [
      user(`first constraints ${pad}`, "u-first"),
      assistant([textItem(`early answer ${pad}`)], "completed", "a-early"),
      user(`middle request ${pad}`, "u-mid"),
      assistant([textItem(`middle answer ${pad}`)], "completed", "a-mid"),
      user(`latest request ${pad}`, "u-last"),
      assistant([textItem(`latest answer ${pad}`)], "completed", "a-last"),
    ];
    const selection = selectHistoricalBlocks({ blocks, budgetTokens: 450, readThreadId: "t-1" });
    const ids = selection.blocks.map((block) => block.blockId);
    // Latest request, latest answer, then the original constraints.
    expect(ids).toContain("u-last");
    expect(ids).toContain("a-last");
    expect(ids).toContain("u-first");
    // The middle exchange did not fit and was dropped whole.
    expect(selection.omittedBlockIds.length).toBeGreaterThan(0);
    expect(selection.blocks.every((block) => block.text.length > 0)).toBe(true);
  });

  test("records omitted block and item ids and points at the read-back", () => {
    const blocks = [
      user("first constraints", "u-first"),
      assistant([textItem("early answer", "early-item")], "completed", "a-early"),
      user("latest request", "u-last"),
    ];
    const selection = selectHistoricalBlocks({ blocks, budgetTokens: 60, readThreadId: "thread-9" });
    // The two shortest priority messages fit; the early answer is dropped.
    expect(selection.omittedBlockIds).toContain("a-early");
    expect(selection.omittedItemIds).toContain("early-item");
    expect(selection.coverage).toContain(HANDOFF_HISTORY_NOTE);
    expect(selection.coverage).toContain('app_read_thread({ threadId: "thread-9"');
    expect(selection.coverage).toContain("blockId");
  });

  test("an oversized single message is omitted whole rather than cut", () => {
    const huge = "x".repeat(100_000);
    const selection = selectHistoricalBlocks({
      blocks: [user(huge, "u-huge"), user("small", "u-small")],
      budgetTokens: 300,
      readThreadId: "t-1",
    });
    expect(selection.blocks.map((block) => block.blockId)).toEqual(["u-small"]);
    expect(selection.omittedBlockIds).toEqual(["u-huge"]);
  });

  test("respects an include predicate (side chat replays imports only)", () => {
    const blocks: StoredBlock[] = [
      { ...user("native prompt", "u-native") },
      { ...user("imported prompt", "u-import"), source: "fork-import" },
    ];
    const selection = selectHistoricalBlocks({
      blocks,
      budgetTokens: 10_000,
      readThreadId: "t-1",
      include: (block) => block.source === "fork-import",
    });
    expect(selection.blocks.map((block) => block.blockId)).toEqual(["u-import"]);
  });

  test("a zero budget keeps only the coverage note", () => {
    const selection = selectHistoricalBlocks({
      blocks: [user("a", "u-a"), user("b", "u-b")],
      budgetTokens: 0,
      readThreadId: "t-1",
    });
    expect(selection.blocks).toEqual([]);
    expect(selection.omittedBlockIds).toEqual(["u-a", "u-b"]);
  });

  test("omits the read-back tool name when the session has no gateway", () => {
    const selection = selectHistoricalBlocks({
      blocks: [user("a", "u-a"), user("b", "u-b")],
      budgetTokens: 0,
      readThreadId: "t-1",
      readBackTool: null,
    });
    expect(selection.coverage).toContain("remain in this thread");
    expect(selection.coverage).not.toContain("app_read_thread");
  });
});

describe("renderHistorySelection", () => {
  test("frames intro, title, branch, coverage and the whole messages", () => {
    const selection = selectHistoricalBlocks({
      blocks: [user("why did it fail", "u-1"), assistant([textItem("env was missing")], "completed", "a-1")],
      budgetTokens: 10_000,
      readThreadId: "t-1",
    });
    const text = renderHistorySelection(selection, {
      intro: "This conversation was handed off.",
      title: "Fix the build",
      branch: "main",
    });
    expect(text).toContain("This conversation was handed off.");
    expect(text).toContain("Original conversation title: Fix the build");
    expect(text).toContain("Git branch: main");
    expect(text).toContain("User:\nwhy did it fail");
    expect(text).toContain("Assistant:\nenv was missing");
    expect(text).toContain(HANDOFF_HISTORY_NOTE);
  });
});
